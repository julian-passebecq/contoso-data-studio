"""Release-gap tests for F04 (Query, Import) and F02 (generator determinism).

All tests run against real DuckDB / DuckLake services in a temporary workspace.
"""

from pathlib import Path

import duckdb
import pytest

from app.config import Settings
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService
from app.services.generator import GeneratorService


REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("CONTOSO_WORKSPACE", str(tmp_path / "ws-env"))
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(REPO_ROOT))
    monkeypatch.delenv("CONTOSO_DUCKLAKE_CATALOG", raising=False)
    monkeypatch.delenv("CONTOSO_DUCKLAKE_DATA_PATH", raising=False)


def _lake_with_numbers(tmp_path: Path, rows: int = 50) -> DuckLakeService:
    workspace = tmp_path / "lake"
    workspace.mkdir()
    settings = Settings(workspace=workspace)
    parquet = workspace / "numbers.parquet"
    con = duckdb.connect(":memory:")
    try:
        con.execute(
            f"COPY (SELECT i::BIGINT AS id, (i % 3)::INTEGER AS bucket FROM range({rows}) t(i)) "
            f"TO '{parquet.as_posix()}' (FORMAT PARQUET)"
        )
    finally:
        con.close()
    service = DuckLakeService(settings)
    service.load_parquet_to_bronze({"numbers": parquet})
    return service


# ---------------------------------------------------------------- F04 Query


def test_query_truncates_at_requested_limit(tmp_path: Path):
    service = _lake_with_numbers(tmp_path, rows=50)

    columns, rows, truncated = service.query(
        "select id, bucket from contoso.bronze.numbers order by id", 7
    )

    assert columns == ["id", "bucket"]
    assert truncated is True
    assert len(rows) == 7
    assert [row[0] for row in rows] == list(range(7))

    _, all_rows, not_truncated = service.query(
        "select id from contoso.bronze.numbers", 50
    )
    assert not_truncated is False
    assert len(all_rows) == 50


def test_query_uses_read_only_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service = _lake_with_numbers(tmp_path)
    seen: list[bool] = []
    original = service.connection

    def spy(read_only: bool = False):
        seen.append(read_only)
        return original(read_only=read_only)

    monkeypatch.setattr(service, "connection", spy)
    service.query("select count(*) from contoso.bronze.numbers", 10)

    assert seen == [True]


def test_read_only_catalog_rejects_writes_even_past_the_guard(tmp_path: Path):
    service = _lake_with_numbers(tmp_path)

    with service.connection(read_only=True) as con:
        with pytest.raises(duckdb.Error):
            con.execute("CREATE TABLE contoso.bronze.sneaky AS SELECT 1 AS x")
        with pytest.raises(duckdb.Error):
            con.execute("INSERT INTO contoso.bronze.numbers VALUES (999, 0)")

    _, rows, _ = service.query("select count(*) from contoso.bronze.numbers", 10)
    assert rows == [[50]]
    assert ("bronze", "sneaky") not in {
        (str(t["schema"]), str(t["name"])) for t in service.catalog()
    }


@pytest.mark.parametrize(
    "sql,needle",
    [
        ("select * from contoso.bronze.no_such_table", "no_such_table"),
        ("select no_such_column from contoso.bronze.numbers", "no_such_column"),
    ],
)
def test_failing_select_raises_useful_error(tmp_path: Path, sql: str, needle: str):
    service = _lake_with_numbers(tmp_path)

    with pytest.raises(duckdb.Error) as excinfo:
        service.query(sql, 10)

    assert needle in str(excinfo.value)


# ---------------------------------------------------------------- F04 Import


def _xlsx_bytes(tmp_path: Path) -> bytes:
    target = tmp_path / "source.xlsx"
    con = duckdb.connect(":memory:")
    try:
        try:
            try:
                con.execute("LOAD excel")
            except duckdb.Error:
                con.execute("INSTALL excel")
                con.execute("LOAD excel")
            con.execute(
                "COPY (SELECT * FROM (VALUES (1, 'alpha', '=1+1'), (2, 'beta', '=cmd|'' /C calc''!A0')) "
                "t(id, name, note)) "
                f"TO '{target.as_posix()}' (FORMAT xlsx, HEADER true)"
            )
            return target.read_bytes()
        except duckdb.Error:
            pass
    finally:
        con.close()

    openpyxl = pytest.importorskip(
        "openpyxl", reason="neither the DuckDB excel extension nor openpyxl is available"
    )
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["id", "name", "note"])
    sheet.append([1, "alpha", "'=1+1"])
    sheet.append([2, "beta", "'=cmd|' /C calc'!A0"])
    workbook.save(target)
    return target.read_bytes()


def test_xlsx_import_is_inspected_as_data(tmp_path: Path):
    workspace = tmp_path / "ws"
    service = ExplorerService(Settings.named("default", workspace))
    payload = _xlsx_bytes(tmp_path)

    imported = service.import_file("book.xlsx", payload)
    try:
        result = service.inspect(imported["path"], limit=10)
    except duckdb.Error as exc:  # excel extension unavailable offline
        pytest.skip(f"DuckDB excel extension unavailable: {exc}")

    assert imported["format"] == "Excel"
    assert result["metadata"]["format"] == "Excel"
    assert result["metadata"]["row_count"] == 2
    assert result["metadata"]["sheets"]
    assert [str(c).lower() for c in result["columns"]] == ["id", "name", "note"]
    names = [row[1] for row in result["rows"]]
    assert names == ["alpha", "beta"]
    # Formula-like text is returned as text, never evaluated.
    assert all(isinstance(row[2], str) for row in result["rows"])
    assert "2" not in [row[2] for row in result["rows"]]


def test_csv_formula_cells_stay_inert_text(tmp_path: Path):
    service = ExplorerService(Settings(workspace=tmp_path))
    payload = (
        b"id,payload\n"
        b"1,\"=cmd|' /C calc'!A0\"\n"
        b"2,=HYPERLINK(\"http://example.invalid\")\n"
        b"3,@SUM(1+1)\n"
    )

    imported = service.import_file("formulas.csv", payload)
    result = service.inspect(imported["path"], limit=10)

    values = [row[1] for row in result["rows"]]
    assert values[0] == "=cmd|' /C calc'!A0"
    assert values[1].startswith("=HYPERLINK(")
    assert values[2] == "@SUM(1+1)"
    assert all(isinstance(v, str) for v in values)
    assert (tmp_path / imported["path"]).read_bytes() == payload


def test_json_proto_keys_stay_inert(tmp_path: Path):
    service = ExplorerService(Settings(workspace=tmp_path))
    payload = (
        b'[{"id":1,"__proto__":{"polluted":true},"constructor":"x"},'
        b'{"id":2,"__proto__":{"polluted":false},"constructor":"y"}]'
    )

    imported = service.import_file("proto.json", payload)
    result = service.inspect(imported["path"], limit=10)

    assert "__proto__" in result["columns"]
    assert "constructor" in result["columns"]
    assert result["metadata"]["row_count"] == 2
    assert result["raw_text"] == payload.decode("utf-8")
    proto_index = result["columns"].index("__proto__")
    assert result["rows"][0][proto_index] == {"polluted": True}


@pytest.mark.parametrize(
    "filename",
    [
        "../escape.csv",
        "../../escape.csv",
        "..\\..\\escape.csv",
        "/etc/escape.csv",
        "C:\\Windows\\escape.csv",
        "sub/dir/escape.csv",
    ],
)
def test_import_names_with_traversal_are_confined_to_imports(tmp_path: Path, filename: str):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    service = ExplorerService(Settings(workspace=workspace))
    imports = (workspace / "imports").resolve()

    try:
        imported = service.import_file(filename, b"a\n1\n")
    except ValueError:
        return  # rejected outright is acceptable

    written = (workspace / imported["path"]).resolve()
    assert written.parent == imports
    assert imported["path"].startswith("imports/")
    assert written.read_bytes() == b"a\n1\n"
    assert not (tmp_path / "escape.csv").exists()
    assert sorted(p for p in tmp_path.rglob("*") if p.is_file()) == [written]


@pytest.mark.parametrize("filename", ["..", ".", "../", "nofile"])
def test_import_rejects_names_without_a_usable_file(tmp_path: Path, filename: str):
    service = ExplorerService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError):
        service.import_file(filename, b"a\n1\n")


# ---------------------------------------------------------------- F02 determinism


def _generate(tmp_path: Path, name: str, seed: int) -> dict:
    workspace = tmp_path / name
    workspace.mkdir()
    return GeneratorService(Settings(workspace=workspace)).generate("retail-baseline", 1000, seed)


def test_generator_is_deterministic_across_fresh_workspaces(tmp_path: Path):
    first = _generate(tmp_path, "run-a", 123)
    second = _generate(tmp_path, "run-b", 123)

    assert first["run_id"] != second["run_id"]
    assert set(first["file_sha256"]) == {
        "customer", "product", "store", "currency_exchange", "sales"
    }
    assert first["file_sha256"] == second["file_sha256"]


def test_generator_seed_changes_sales_hash(tmp_path: Path):
    base = _generate(tmp_path, "seed-123", 123)
    other = _generate(tmp_path, "seed-456", 456)

    assert base["file_sha256"]["sales"] != other["file_sha256"]["sales"]
