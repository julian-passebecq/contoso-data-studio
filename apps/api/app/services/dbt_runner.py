from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.catalog_lock import catalog_lock


ALLOWED_COMMANDS = {"build", "run", "test", "parse"}
# Fabric-style app lab models (docs/fabric-apps) are disabled unless dbt gets
# --vars '{"fabric_apps_enabled": true}'; a build of one of them must pass it.
FABRIC_APPS_DIR = "fabric_apps"
DBT_PROJECT = "contoso_data_studio"
# Per-model record of the last successful dbt build, kept next to run_results.json (which dbt
# overwrites on every invocation). A FOIL build selects path:models/foil only, so retail Gold keeps
# its previous build: this ledger is what lets the app say so instead of staying silent.
BUILD_LEDGER = "contoso_build_ledger.json"
BUILD_COMMANDS = {"build", "run"}


class DbtService:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def executable(self) -> str | None:
        return shutil.which("dbt")

    def _foil_active(self) -> bool:
        from app.services.generator import GeneratorService
        run = GeneratorService(self.settings).active_run()
        return bool(run and str(run.get("scenario", "")).startswith("foil-"))

    def _models(self) -> list[dict[str, Any]]:
        models_root = self.settings.dbt_path / "models"
        if not models_root.exists():
            return []
        models: list[dict[str, Any]] = []
        foil_active = self._foil_active()
        for path in sorted(models_root.rglob("*.sql")):
            relative = path.relative_to(self.settings.dbt_path)
            if ("foil" in relative.parts) != foil_active:
                continue
            layer = path.parent.name
            model: dict[str, Any] = {
                "name": path.stem,
                "path": relative.as_posix(),
                "layer": layer,
            }
            if FABRIC_APPS_DIR in relative.parts:
                model["app_lab"] = True
            models.append(model)
        return models

    def _app_lab_enabled(self) -> bool:
        """The app lab is enabled in this workspace once its operational store exists."""
        from app.services.fabric_apps import APP_SLUG
        return (self.settings.workspace / "fabric-apps" / f"{APP_SLUG}.sqlite").exists()

    def _read_manifest(self) -> dict[str, Any] | None:
        path = self.settings.dbt_target_path / "manifest.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    @staticmethod
    def _layer_for_dependency(
        dependency_id: str,
        manifest: dict[str, Any],
    ) -> tuple[str, str]:
        node = manifest.get("nodes", {}).get(dependency_id)
        if node:
            name = str(node.get("name") or dependency_id)
            path = str(node.get("original_file_path") or "")
            parts = Path(path).parts
            for layer in ("bronze", "silver", "gold"):
                if layer in parts:
                    return layer, name
            return str(node.get("schema") or "model"), name

        source = manifest.get("sources", {}).get(dependency_id)
        if source:
            return "bronze", str(source.get("name") or dependency_id)

        return "unknown", dependency_id

    def lineage(self) -> dict[str, Any]:
        manifest = self._read_manifest()
        if manifest is None:
            return {
                "generated_at": None,
                "nodes": [],
                "edges": [],
            }

        nodes: list[dict[str, Any]] = []
        known_ids: set[str] = set()
        foil_active = self._foil_active()

        for unique_id, source in manifest.get("sources", {}).items():
            if (source.get("source_name") == "foil") != foil_active:
                continue
            if not str(unique_id).startswith("source."):
                continue
            node = {
                "id": str(unique_id),
                "name": str(source.get("name") or unique_id),
                "resource_type": "source",
                "layer": "bronze",
                "path": str(source.get("original_file_path") or ""),
                "schema": source.get("schema"),
                "database": source.get("database"),
                "materialized": "source",
            }
            nodes.append(node)
            known_ids.add(str(unique_id))

        for unique_id, model in manifest.get("nodes", {}).items():
            if ("foil" in Path(str(model.get("original_file_path", ""))).parts) != foil_active:
                continue
            if not str(unique_id).startswith("model."):
                continue
            layer, name = self._layer_for_dependency(str(unique_id), manifest)
            config = model.get("config") or {}
            node = {
                "id": str(unique_id),
                "name": name,
                "resource_type": "model",
                "layer": layer,
                "path": str(model.get("original_file_path") or ""),
                "schema": model.get("schema"),
                "database": model.get("database"),
                "materialized": str(config.get("materialized") or "model"),
            }
            nodes.append(node)
            known_ids.add(str(unique_id))

        edges: list[dict[str, str]] = []
        for unique_id, model in manifest.get("nodes", {}).items():
            target = str(unique_id)
            if target not in known_ids or not target.startswith("model."):
                continue
            for dependency in model.get("depends_on", {}).get("nodes", []):
                source = str(dependency)
                if source not in known_ids:
                    continue
                edges.append({"source": source, "target": target})

        order = {"bronze": 0, "silver": 1, "gold": 2}
        nodes.sort(key=lambda item: (
            order.get(str(item["layer"]), 99),
            str(item["name"]),
        ))
        edges.sort(key=lambda item: (item["source"], item["target"]))

        return {
            "generated_at": manifest.get("metadata", {}).get("generated_at"),
            "nodes": nodes,
            "edges": edges,
        }

    def node_detail(self, unique_id: str) -> dict[str, Any]:
        manifest = self._read_manifest()
        if manifest is None:
            raise ValueError("dbt manifest is not available. Run dbt Parse or Build first.")

        nodes = manifest.get("nodes", {})
        sources = manifest.get("sources", {})
        node = nodes.get(unique_id) or sources.get(unique_id)
        if not isinstance(node, dict):
            raise ValueError(f"Unknown dbt node: {unique_id}")

        resource_type = "source" if unique_id.startswith("source.") else "model"
        layer, name = self._layer_for_dependency(unique_id, manifest)
        config = node.get("config") or {}
        original_file_path = str(node.get("original_file_path") or "")
        source_code: str | None = None

        if original_file_path:
            candidate = (self.settings.dbt_path / original_file_path).resolve()
            project_root = self.settings.dbt_path.resolve()
            if candidate.is_relative_to(project_root) and candidate.is_file():
                try:
                    source_code = candidate.read_text(encoding="utf-8")
                except OSError:
                    source_code = None

        raw_code = node.get("raw_code")
        if source_code is None and isinstance(raw_code, str):
            source_code = raw_code

        compiled_code = node.get("compiled_code")
        if not isinstance(compiled_code, str) or not compiled_code.strip():
            compiled_code = None

        if compiled_code is None and resource_type == "model" and original_file_path:
            compiled_root = self.settings.dbt_target_path / "compiled"
            if compiled_root.exists():
                for package_dir in sorted(compiled_root.iterdir()):
                    if not package_dir.is_dir():
                        continue
                    candidate = (package_dir / original_file_path).resolve()
                    if (
                        candidate.is_relative_to(compiled_root.resolve())
                        and candidate.is_file()
                    ):
                        try:
                            compiled_code = candidate.read_text(encoding="utf-8")
                        except OSError:
                            compiled_code = None
                        if compiled_code:
                            break

        dependencies = [
            str(item)
            for item in node.get("depends_on", {}).get("nodes", [])
            if str(item) in nodes or str(item) in sources
        ]
        downstream: list[str] = []
        for candidate_id, candidate_node in nodes.items():
            candidate_id_text = str(candidate_id)
            if not candidate_id_text.startswith("model."):
                continue
            candidate_dependencies = candidate_node.get("depends_on", {}).get("nodes", [])
            if unique_id in candidate_dependencies:
                downstream.append(candidate_id_text)

        def describe(item_id: str) -> dict[str, Any]:
            item = nodes.get(item_id) or sources.get(item_id) or {}
            item_layer, item_name = self._layer_for_dependency(item_id, manifest)
            return {
                "id": item_id,
                "name": item_name,
                "layer": item_layer,
                "resource_type": "source" if item_id.startswith("source.") else "model",
            }

        quality = self.quality()
        tests = [
            test
            for test in quality.get("tests", [])
            if test.get("layer") == layer and test.get("model") == name
        ]

        columns = []
        for column_name, column in (node.get("columns") or {}).items():
            column_data = column if isinstance(column, dict) else {}
            columns.append({
                "name": str(column_name),
                "description": column_data.get("description"),
                "data_type": column_data.get("data_type"),
            })

        schema = node.get("schema")
        database = node.get("database")
        relation_name = node.get("relation_name")
        materialized = "source" if resource_type == "source" else str(config.get("materialized") or "model")
        physical_query = None
        if isinstance(relation_name, str) and relation_name.strip():
            physical_query = f"select * from {relation_name.strip()} limit 100;"
        elif layer in {"bronze", "silver", "gold"}:
            physical_query = f"select * from contoso.{layer}.{name} limit 100;"

        return {
            "id": unique_id,
            "name": name,
            "resource_type": resource_type,
            "layer": layer,
            "path": original_file_path,
            "schema": schema,
            "database": database,
            "relation_name": relation_name,
            "materialized": materialized,
            "source_code": source_code,
            "compiled_code": compiled_code,
            "physical_query": physical_query,
            "upstream": [describe(item_id) for item_id in dependencies],
            "downstream": [describe(item_id) for item_id in sorted(downstream)],
            "tests": tests,
            "columns": columns,
        }

    def quality(self) -> dict[str, Any]:
        run_results_path = self.settings.dbt_target_path / "run_results.json"
        manifest = self._read_manifest()
        if not run_results_path.exists() or manifest is None:
            return {
                "generated_at": None,
                "summary": {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0},
                "by_layer": {},
                "tests": [],
            }

        try:
            run_payload = json.loads(run_results_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {
                "generated_at": None,
                "summary": {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0},
                "by_layer": {},
                "tests": [],
            }

        tests: list[dict[str, Any]] = []
        summary = {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0}
        by_layer: dict[str, dict[str, int]] = {}

        for result in run_payload.get("results", []):
            unique_id = str(result.get("unique_id") or "")
            if not unique_id.startswith("test."):
                continue

            node = manifest.get("nodes", {}).get(unique_id, {})
            dependencies = node.get("depends_on", {}).get("nodes", [])
            attached_node = node.get("attached_node")
            dependency_id = attached_node or next(
                (
                    item for item in dependencies
                    if str(item).startswith(("model.", "source."))
                ),
                dependencies[0] if dependencies else "",
            )
            layer, model_name = self._layer_for_dependency(str(dependency_id), manifest)
            raw_status = str(result.get("status") or "error").lower()
            status = {
                "success": "pass",
                "passed": "pass",
                "skipped": "skip",
            }.get(raw_status, raw_status)
            if status not in {"pass", "fail", "warn", "error", "skip"}:
                status = "error"

            summary["total"] += 1
            summary[status] += 1
            layer_summary = by_layer.setdefault(
                layer,
                {"total": 0, "pass": 0, "fail": 0, "warn": 0, "error": 0, "skip": 0},
            )
            layer_summary["total"] += 1
            layer_summary[status] += 1

            metadata = node.get("test_metadata") or {}
            tests.append({
                "unique_id": unique_id,
                "name": str(node.get("name") or unique_id),
                "test_type": str(metadata.get("name") or "test"),
                "column_name": node.get("column_name"),
                "layer": layer,
                "model": model_name,
                "status": status,
                "failures": result.get("failures"),
                "execution_time": result.get("execution_time"),
                "message": result.get("message"),
            })

        tests.sort(key=lambda item: (
            0 if item["status"] in {"fail", "error", "warn"} else 1,
            str(item["layer"]),
            str(item["model"]),
            str(item["name"]),
        ))

        return {
            "generated_at": run_payload.get("metadata", {}).get("generated_at"),
            "summary": summary,
            "by_layer": by_layer,
            "tests": tests,
        }

    def _read_run_results(self) -> dict[str, Any] | None:
        path = self.settings.dbt_target_path / "run_results.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

        results = []
        for item in payload.get("results", []):
            node = item.get("unique_id", "")
            results.append({
                "unique_id": node,
                "status": item.get("status"),
                "execution_time": item.get("execution_time"),
                "message": item.get("message"),
            })
        return {
            "elapsed_time": payload.get("elapsed_time"),
            "generated_at": payload.get("metadata", {}).get("generated_at"),
            "invocation_id": payload.get("metadata", {}).get("invocation_id"),
            "results": results,
        }

    def status(self) -> dict[str, Any]:
        return {
            "available": self.executable is not None,
            "executable": self.executable,
            "project_dir": str(self.settings.dbt_path),
            "models": self._models(),
            "latest_run": self._read_run_results(),
            "quality": self.quality(),
        }

    def _validate_model_selector(self, selector: str) -> dict[str, Any]:
        requested = selector.strip()
        if not requested:
            raise ValueError("dbt model selector is empty")
        matches = [
            model
            for model in self._models()
            if model["name"] == requested
        ]
        if len(matches) != 1:
            raise ValueError(f"Unknown dbt model selector: {requested}")
        return matches[0]

    def run(self, command: str, selector: str | None = None) -> dict[str, Any]:
        with catalog_lock(self.settings.catalog_path):
            return self._run(command, selector)

    def _run(self, command: str, selector: str | None = None) -> dict[str, Any]:
        if command not in ALLOWED_COMMANDS:
            raise ValueError(f"Unsupported dbt command: {command}")
        executable = self.executable
        if not executable:
            raise RuntimeError(
                'dbt is not installed. Install the API with: pip install -e "apps/api[dbt]"'
            )

        args = [
            executable,
            command,
            "--project-dir",
            str(self.settings.dbt_path),
            "--profiles-dir",
            str(self.settings.dbt_path),
            "--no-use-colors",
        ]
        selected_model = None
        dbt_vars: dict[str, bool] = {}
        if self._foil_active():
            dbt_vars["foil_enabled"] = True
            if command != "parse" and selector is None:
                args.extend(["--select", "path:models/foil"])
        if selector is not None:
            if command not in {"build", "run", "test"}:
                raise ValueError(f"dbt {command} does not accept a model selector here")
            model = self._validate_model_selector(selector)
            selected_model = model["name"]
            if model.get("app_lab"):
                # App Gold is built by dbt build of the app's own model (docs/fabric-apps/GOLD-MAPPING.md).
                if not self._app_lab_enabled():
                    raise ValueError(
                        f"{selected_model} is the Sales Forecasting app lab's Gold model, and the lab is not "
                        "enabled in this workspace yet. Open the Apps page so the lab creates its store and "
                        "mirrors Bronze, then build it again."
                    )
                dbt_vars["fabric_apps_enabled"] = True
            args.extend(["--select", selected_model])
        if dbt_vars:
            args.extend(["--vars", json.dumps(dbt_vars)])

        previous = self._read_run_results()
        previous_generated_at = previous.get("generated_at") if previous else None
        completed = subprocess.run(
            args,
            cwd=self.settings.dbt_path,
            env=self.settings.dbt_env(),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        run_results = self._read_run_results()
        if run_results is not None and previous is not None and run_results["generated_at"] == previous_generated_at:
            run_results = None  # dbt wrote no new run_results: never show the previous run as this one
        if run_results is not None and command in BUILD_COMMANDS:
            self._record_build(command, selected_model, bool(dbt_vars.get("foil_enabled")), run_results)
        nodes_executed = len(run_results["results"]) if run_results else 0
        ok = completed.returncode == 0
        warning = None
        if ok and command != "parse" and nodes_executed == 0:
            # dbt exits 0 with "Nothing to do" when the selection matches no enabled node.
            ok = False
            target = f"--select {selected_model}" if selected_model else "the project"
            warning = f"dbt {command} executed 0 nodes for {target}: nothing was built or tested."
        return {
            "command": command,
            "selector": selected_model,
            "exit_code": completed.returncode,
            "ok": ok,
            "nodes_executed": nodes_executed,
            "warning": warning,
            "output": combined[-50_000:],
            "run_results": run_results or {"elapsed_time": None, "generated_at": None, "results": []},
        }

    # ----- per-model build ledger --------------------------------------------------------
    @property
    def _ledger_path(self) -> Path:
        return self.settings.dbt_target_path / BUILD_LEDGER

    def _read_ledger(self) -> dict[str, Any]:
        try:
            payload = json.loads(self._ledger_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        models = payload.get("models")
        latest = payload.get("latest_build")
        return {
            "models": models if isinstance(models, dict) else {},
            "latest_build": latest if isinstance(latest, dict) else None,
        }

    @staticmethod
    def _merge_build(ledger: dict[str, Any], build: dict[str, Any], results: list[dict[str, Any]]) -> None:
        """Make `build` the latest build and stamp every model it built successfully."""
        statuses = {
            str(item.get("unique_id")): item.get("status")
            for item in results
            if str(item.get("unique_id", "")).startswith("model.")
        }
        ledger["latest_build"] = {**build, "models": statuses}
        for unique_id, status in statuses.items():
            if status == "success":
                ledger["models"][unique_id] = dict(build)

    def _record_build(
        self,
        command: str,
        selector: str | None,
        foil_active: bool,
        run_results: dict[str, Any],
    ) -> None:
        if not any(str(item.get("unique_id", "")).startswith("model.") for item in run_results["results"]):
            return
        ledger = self._read_ledger()
        build = {
            "invocation_id": run_results.get("invocation_id"),
            "generated_at": run_results.get("generated_at"),
            "command": command,
            "selector": selector,
            "scope": "foil" if foil_active else "retail",
        }
        self._merge_build(ledger, build, run_results["results"])
        path = self._ledger_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(ledger, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _gold_model_files(self) -> list[dict[str, Any]]:
        """Every Gold model of the project, retail, FOIL and app lab alike (not only the active ones)."""
        models_root = self.settings.dbt_path / "models"
        if not models_root.exists():
            return []
        models = []
        for path in sorted(models_root.rglob("*.sql")):
            if path.parent.name != "gold":
                continue
            relative = path.relative_to(self.settings.dbt_path)
            if "foil" in relative.parts:
                scope = "foil"
            elif FABRIC_APPS_DIR in relative.parts:
                scope = "app_lab"
            else:
                scope = "retail"
            models.append({"name": path.stem, "path": relative.as_posix(), "scope": scope})
        return models

    @staticmethod
    def _short_id(build: dict[str, Any] | None) -> str | None:
        invocation = (build or {}).get("invocation_id")
        return str(invocation)[:8] if invocation else None

    def gold_builds(self) -> dict[str, Any]:
        """For each Gold model: the dbt invocation and time of its last successful build, and
        whether the latest dbt build/run rebuilt it (a FOIL build never rebuilds retail Gold)."""
        ledger = self._read_ledger()
        latest_results = self._read_run_results()
        if (
            ledger["latest_build"] is None
            and latest_results is not None
            and latest_results.get("generated_at")
            and any(item["unique_id"].startswith("model.") for item in latest_results["results"])
        ):
            # A workspace built before the ledger existed: its run_results.json is the only record,
            # so count it as the latest build, command and scope unknown.
            self._merge_build(ledger, {
                "invocation_id": latest_results.get("invocation_id"),
                "generated_at": latest_results.get("generated_at"),
                "command": None,
                "selector": None,
                "scope": None,
            }, latest_results["results"])

        foil_active = self._foil_active()
        latest = ledger["latest_build"]
        latest_models: dict[str, Any] = (latest or {}).get("models") or {}
        rows = []
        for model in self._gold_model_files():
            unique_id = f"model.{DBT_PROJECT}.{model['name']}"
            last = ledger["models"].get(unique_id)
            latest_status = latest_models.get(unique_id)
            rows.append({
                **model,
                "unique_id": unique_id,
                "in_active_project": (model["scope"] == "foil") == foil_active,
                "last_build": {**last, "short_id": self._short_id(last)} if last else None,
                "latest_build_status": latest_status,
                "rebuilt_by_latest": latest is not None and latest_status == "success",
            })
        summary = None
        if latest:
            summary = {key: value for key, value in latest.items() if key != "models"}
            summary["short_id"] = self._short_id(latest)
        return {"foil_active": foil_active, "latest_build": summary, "models": rows}
