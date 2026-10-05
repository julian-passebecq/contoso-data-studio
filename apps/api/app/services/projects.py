"""Activate a saved local project and validate its complete decision pipeline."""
import hashlib
import json
from threading import Lock

from app.services.generator import SCENARIO_CONFIG
from app.services.catalog_lock import catalog_lock


class ProjectBusyError(RuntimeError):
    pass


class ProjectService:
    def __init__(self, generator, ducklake, dbt, state):
        self.generator, self.ducklake, self.dbt, self.state = generator, ducklake, dbt, state
        self._lock = Lock()
        self.receipt = generator.settings.workspace / "project-ready.json"

    def _signature(self):
        active = self.generator.active_run()
        digest = hashlib.sha256(json.dumps(active, sort_keys=True).encode())
        root = self.generator.settings.dbt_path
        paths = [root / "dbt_project.yml", root / "profiles.yml", root / "target/run_results.json"]
        for folder in ("models", "macros"):
            paths.extend(sorted((root / folder).rglob("*")))
        for path in paths:
            if path.is_file():
                digest.update(path.relative_to(root).as_posix().encode())
                digest.update(path.read_bytes())
        return digest.hexdigest()

    def _quality_ok(self):
        quality = self.dbt.quality()["summary"]
        return quality.get("total", 0) > 0 and quality.get("fail", 0) == quality.get("error", 0) == quality.get("skip", 0) == 0

    def open(self, scenario):
        if scenario not in SCENARIO_CONFIG:
            raise ValueError("Unknown project")
        if not self._lock.acquire(blocking=False):
            raise ProjectBusyError("Another project is opening. Please wait for it to finish.")
        try:
            with catalog_lock(self.generator.settings.catalog_path):
                return self._open(scenario)
        finally:
            self._lock.release()

    def _open(self, scenario):
        fingerprint = self.generator.fingerprint(scenario)
        active = self.generator.active_run()
        # Retain the user's active seed/scale when reopening the same project.
        candidates = ([active] if active and active["scenario"] == scenario else [])
        candidates += [run for run in self.generator.list_runs(100)
                       if run["scenario"] == scenario and run["seed"] == 42 and run["scale"] == 10_000]
        run = None
        for candidate in candidates:
            detail = self.generator.get_run(candidate["run_id"])
            if detail.get("generator_sha256") == fingerprint and detail.get("integrity_tracked"):
                # Fail visibly on damaged saved data; never silently replace it.
                self.generator.run_files(detail["run_id"], verify_hashes=True)
                run = detail
                break
        generated = run is None
        if generated:
            manifest = self.generator.generate(scenario, 10_000, 42)
            run = self.generator.get_run(manifest["run_id"])
        same_active = active and active["run_id"] == run["run_id"]
        try:
            receipt = json.loads(self.receipt.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            receipt = {}
        current = self.state.state()
        if same_active and current["ready"] and self._quality_ok() and receipt.get("signature") == self._signature():
            return {"state": current, "generated": False, "resumed": True}
        if not same_active:
            self.ducklake.load_parquet_to_bronze(self.generator.run_files(run["run_id"], verify_hashes=True))
            snapshots = self.ducklake.snapshots(1)
            self.generator.mark_bronze_loaded(run["run_id"], int(snapshots[0]["snapshot_id"]) if snapshots else None)
        build = self.dbt.run("build")
        if not build["ok"]:
            raise RuntimeError("Project build failed. Inspect Transform for diagnostics.\n" + build["output"][-4000:])
        current = self.state.state()
        if not current["ready"] or current["active_scenario"] != scenario or not self._quality_ok():
            raise RuntimeError("Project did not pass its data, Gold and quality checks. Inspect Transform.")
        self.receipt.write_text(json.dumps({"signature": self._signature(), "scenario": scenario}), encoding="utf-8")
        return {"state": current, "generated": generated, "resumed": False}
