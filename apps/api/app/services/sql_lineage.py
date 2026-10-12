"""Runtime lineage for a read-only Query workbench statement, resolved by DuckDB itself.

Two DuckDB facilities, no heuristics on the SQL text:

1. ``json_serialize_sql`` (DuckDB's own parser) lists every relation the statement names:
   base tables with catalog/schema/table and their ``AT (VERSION => n)`` clause, table
   functions, and CTE names (CTE references are not relations of the lake).
2. ``EXPLAIN (FORMAT JSON)`` on the same read-only connection binds the statement and gives
   the physical plan; each lake scan names its table and the columns it projects. Filter
   pushdown and statistics propagation are disabled for this EXPLAIN only, so filter columns
   stay in the scan projections and ``count(*)`` keeps its scan.

A relation is ``verified`` when the bound plan has a scan for it that no other named relation
could claim; ``inferred`` when DuckDB bound it but the plan cannot attribute columns to it
(several relations share a table name, or the optimizer removed the scan); ``unresolved``
when it is not a table of the attached lake (table function, unknown table, other catalog).
Nothing is guessed: unattributed columns are left empty. EXPLAIN does not execute the
statement; it only runs after the validated statement itself already ran.
"""
from __future__ import annotations

import json
from typing import Any, Iterable

import duckdb

LAKE_CATALOG = "contoso"
LAYERS = ("bronze", "silver", "gold")
# Optimizers that would hide columns or scans from the plan; disabled for the EXPLAIN only.
_EXPLAIN_DISABLED_OPTIMIZERS = "filter_pushdown,statistics_propagation"
_RANK = {"verified": 0, "inferred": 1, "unresolved": 2}


def _walk(node: Any) -> Iterable[dict[str, Any]]:
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def parse_relations(con: duckdb.DuckDBPyConnection, statement: str) -> dict[str, Any]:
    """Relations named by ``statement`` according to DuckDB's parser (no binding)."""
    raw = con.execute("SELECT json_serialize_sql(?)", [statement]).fetchone()[0]
    tree = json.loads(raw)
    if tree.get("error"):
        raise ValueError(str(tree.get("error_message") or "DuckDB could not parse the statement"))

    cte_names: set[str] = set()
    for node in _walk(tree):
        cte_map = node.get("cte_map")
        if isinstance(cte_map, dict):
            for entry in cte_map.get("map") or []:
                if isinstance(entry, dict) and entry.get("key"):
                    cte_names.add(str(entry["key"]).lower())

    tables: list[dict[str, Any]] = []
    functions: list[str] = []
    for node in _walk(tree):
        kind = node.get("type")
        if kind == "BASE_TABLE" and "table_name" in node:
            catalog = str(node.get("catalog_name") or "")
            schema = str(node.get("schema_name") or "")
            table = str(node.get("table_name") or "")
            if not catalog and not schema and table.lower() in cte_names:
                continue
            at = None
            at_clause = node.get("at_clause")
            if isinstance(at_clause, dict):
                expr = at_clause.get("expr") or {}
                value = (expr.get("value") or {}).get("value") if expr.get("class") == "CONSTANT" else None
                at = {"unit": str(at_clause.get("unit") or ""), "value": value}
            tables.append({"catalog": catalog, "schema": schema, "table": table, "at": at})
        elif kind == "TABLE_FUNCTION":
            function = node.get("function") or {}
            functions.append(str(function.get("function_name") or "table function"))
    return {"tables": tables, "functions": functions, "ctes": sorted(cte_names)}


def plan_scans(con: duckdb.DuckDBPyConnection, statement: str) -> list[dict[str, Any]]:
    """Table scans of the bound physical plan: [{table, columns}]. Does not execute the statement."""
    previous = con.execute("SELECT current_setting('disabled_optimizers')").fetchone()[0]
    con.execute(f"SET disabled_optimizers = '{_EXPLAIN_DISABLED_OPTIMIZERS}'")
    try:
        rows = con.execute("EXPLAIN (FORMAT JSON) " + statement).fetchall()
    finally:
        restore = str(previous or "").replace("'", "''")
        con.execute(f"SET disabled_optimizers = '{restore}'")

    scans: list[dict[str, Any]] = []
    for _, plan in rows:
        for node in _walk(json.loads(plan)):
            name = str(node.get("name") or "")
            info = node.get("extra_info")
            if not name.endswith("_SCAN") or not isinstance(info, dict) or "Table" not in info:
                continue
            projections = info.get("Projections", [])
            if isinstance(projections, str):
                projections = [projections] if projections else []
            scans.append({
                "table": str(info["Table"]),
                "columns": [str(c) for c in projections if str(c) and not str(c).startswith("#")],
            })
    return scans


def dbt_index(lineage_nodes: Iterable[dict[str, Any]]) -> dict[tuple[str, str], str]:
    """(schema, table) -> dbt unique_id, from the dbt lineage nodes the Transform page uses."""
    index: dict[tuple[str, str], str] = {}
    for node in lineage_nodes:
        name = str(node.get("name") or "").lower()
        if not name:
            continue
        for schema in {str(node.get("layer") or ""), str(node.get("schema") or "")}:
            if schema:
                index.setdefault((schema.lower(), name), str(node.get("id")))
    return index


def resolve(
    con: duckdb.DuckDBPyConnection,
    statement: str,
    dbt_nodes: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Lineage of one validated read-only statement on an open read-only lake connection."""
    words = statement.lstrip().split(None, 1)
    if not words or words[0].lower() not in {"select", "with"}:
        return {
            "relations": [],
            "method": "none",
            "confidence": "unresolved",
            "note": "Only SELECT and WITH statements carry lineage (SHOW, DESCRIBE, EXPLAIN read the catalog)",
        }
    try:
        parsed = parse_relations(con, statement)
    except (duckdb.Error, ValueError) as exc:
        return {
            "relations": [],
            "method": "none",
            "confidence": "unresolved",
            "note": f"DuckDB parser did not return a SELECT tree ({str(exc).splitlines()[0]})",
        }

    plan_error = None
    try:
        scans = plan_scans(con, statement)
    except duckdb.Error as exc:
        scans = None
        plan_error = str(exc).splitlines()[0]

    index = dbt_index(dbt_nodes)
    lake_tables = {
        (str(schema).lower(), str(name).lower())
        for schema, name in con.execute(
            "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ?",
            [LAKE_CATALOG],
        ).fetchall()
    }

    # One entry per distinct relation; AT clauses of the same table are kept together.
    relations: dict[tuple[str, str, str], dict[str, Any]] = {}
    for ref in parsed["tables"]:
        key = (ref["catalog"].lower(), ref["schema"].lower(), ref["table"].lower())
        entry = relations.setdefault(key, {
            "catalog": ref["catalog"] or None,
            "schema": ref["schema"] or None,
            "table": ref["table"],
            "layer": None,
            "dbt_model": None,
            "columns": [],
            "at": [],
            "confidence": "unresolved",
            "note": "",
        })
        if ref["at"] and ref["at"] not in entry["at"]:
            entry["at"].append(ref["at"])

    names = [key[2] for key in relations]
    for (catalog, schema, table), entry in relations.items():
        in_lake = catalog == LAKE_CATALOG and schema in LAYERS
        if not in_lake:
            entry["note"] = "Not a bronze/silver/gold table of the attached lake"
            continue
        entry["layer"] = schema
        entry["dbt_model"] = index.get((schema, table))
        current = (schema, table) in lake_tables
        if scans is None:
            if current:
                entry["confidence"] = "inferred"
                entry["note"] = "Present in the lake catalog; DuckDB plan unavailable, columns not resolved"
            else:
                entry["note"] = "Not a current lake table and DuckDB could not bind it"
            continue
        matching = [scan for scan in scans if scan["table"].lower() == table]
        if names.count(table) > 1:
            entry["confidence"] = "inferred"
            entry["note"] = "Several relations share this table name; the plan names scans by table only"
        elif not matching:
            entry["confidence"] = "inferred"
            entry["note"] = "Bound by DuckDB, but the plan has no scan for it"
        else:
            columns: list[str] = []
            for scan in matching:
                for column in scan["columns"]:
                    if column not in columns:
                        columns.append(column)
            entry["columns"] = columns
            entry["confidence"] = "verified"
            entry["note"] = "Scan of the bound DuckDB plan"

    result = list(relations.values())
    for function in parsed["functions"]:
        result.append({
            "catalog": None, "schema": None, "table": function, "layer": None, "dbt_model": None,
            "columns": [], "at": [], "confidence": "unresolved",
            "note": "Table function: reads outside the lake catalog",
        })

    confidence = "verified"
    for entry in result:
        if _RANK[entry["confidence"]] > _RANK[confidence]:
            confidence = entry["confidence"]
    lineage: dict[str, Any] = {
        "relations": result,
        "method": "duckdb_parser+explain" if scans is not None else "duckdb_parser",
        "confidence": confidence,
    }
    if plan_error:
        lineage["note"] = f"EXPLAIN failed: {plan_error}"
    return lineage
