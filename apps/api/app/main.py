import subprocess
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.models import ArtifactExportRequest, GenerateRequest, QueryRequest, QueryResult, WorkspaceCreate, WorkspaceRestore
from app.services.charts import ChartsService
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService
from app.services.generator import GeneratorService, SCENARIOS
from app.services.workspace_state import WorkspaceStateService
from app.services.projects import ProjectService, ProjectBusyError
from app.services.workspaces import WorkspaceError, WorkspaceRegistry
from app.services.exports import ExportError, ExportService
from app.services.fabric_apps import set_lab

workspaces = WorkspaceRegistry()
_switch_lock = Lock()


def _bind(active: Settings) -> None:
    """(Re)create every workspace-scoped service; nothing from the previous workspace survives."""
    global settings, ducklake, explorer, generator, dbt, charts, workspace_state, projects, exports
    settings = active
    ducklake = DuckLakeService(settings)
    explorer = ExplorerService(settings)
    generator = GeneratorService(settings)
    dbt = DbtService(settings)
    charts = ChartsService(settings)
    workspace_state = WorkspaceStateService(generator, ducklake, dbt)
    projects = ProjectService(generator, ducklake, dbt, workspace_state)
    exports = ExportService(settings, generator, ducklake, dbt)


_bind(workspaces.activate(workspaces.remembered_id(), remember=False))

app = FastAPI(title="Contoso Data Studio API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Fabric-style app lab (local stand-in for a Rayfin operational app). See docs/fabric-apps.
from app.routers.fabric_apps import concept_router as fabric_concept_router  # noqa: E402
from app.routers.fabric_apps import router as fabric_apps_router  # noqa: E402

app.include_router(fabric_apps_router)
app.include_router(fabric_concept_router)


@app.get("/api/health")
def health():
    return {"status": "ok", "workspace": str(settings.workspace), "workspace_id": settings.workspace_id}


@app.get("/api/workspaces")
def list_workspaces():
    return {**workspaces.list(), "backups": workspaces.list_backups()}


@app.post("/api/workspaces")
def create_workspace(request: WorkspaceCreate):
    try:
        created = workspaces.create(request.name)
    except WorkspaceError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return workspaces.describe(created)


def _switch(workspace_id: str) -> dict:
    if not _switch_lock.acquire(blocking=False):
        raise HTTPException(409, detail="Another workspace switch is in progress.")
    try:
        target = workspaces.settings_for(workspace_id)
        # Every service is rebuilt for the target workspace. Work still in flight (a dbt run, an app-lab
        # mirror batch) keeps the Settings it started with, so it only ever writes its own workspace's
        # catalog; nothing has to wait for it. The old mirror stops in the background.
        set_lab(None, wait=False)
        _bind(workspaces.activate(target.workspace_id))
        return {"active": settings.workspace_id, "workspace": workspaces.describe(settings)}
    except WorkspaceError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    finally:
        _switch_lock.release()


@app.post("/api/workspaces/{workspace_id}/activate")
def activate_workspace(workspace_id: str):
    return _switch(workspace_id)


@app.post("/api/workspaces/{workspace_id}/backup")
def backup_workspace(workspace_id: str):
    try:
        return workspaces.backup(workspace_id)
    except WorkspaceError as exc:
        raise HTTPException(400, detail=str(exc)) from exc


@app.post("/api/workspaces/restore")
def restore_workspace(request: WorkspaceRestore):
    try:
        restored = workspaces.restore(request.backup, request.name)
    except WorkspaceError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    return workspaces.describe(restored)


@app.get("/api/scenarios")
def scenarios():
    return SCENARIOS


@app.post("/api/projects/{scenario}/open")
def open_project(scenario: str):
    try:
        return projects.open(scenario)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except ProjectBusyError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/runs")
def runs(limit: int = Query(default=20, ge=1, le=100)):
    try:
        return {"runs": generator.list_runs(limit)}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/runs/compare")
def compare_runs(
    base: str = Query(min_length=1),
    target: str = Query(min_length=1),
):
    try:
        return generator.compare_runs(base, target)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/runs/{run_id}/reproduce")
def reproduce_run(run_id: str):
    try:
        return generator.reproduce_run(run_id)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/runs/{run_id}/verify")
def verify_run(run_id: str):
    try:
        return generator.verify_run(run_id)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    try:
        return generator.get_run(run_id)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/runs/{run_id}/reload")
def reload_run(run_id: str):
    try:
        run = generator.get_run(run_id)
        before = ducklake.snapshots(1)
        run_files = generator.run_files(run_id, verify_hashes=True)
        ducklake.load_parquet_to_bronze(run_files)
        after = ducklake.snapshots(1)
        snapshot_id = int(after[0]["snapshot_id"]) if after else None
        generator.mark_bronze_loaded(run_id, snapshot_id)
        return {
            "run": generator.get_run(run_id),
            "bronze_loaded": True,
            "previous_snapshot_id": int(before[0]["snapshot_id"]) if before else None,
            "snapshot_id": snapshot_id,
            "integrity_verified": bool(generator.get_run(run_id).get("integrity_tracked")),
        }
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/workspace/active-run")
def active_run():
    try:
        return {"run": generator.active_run()}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/workspace/project-state")
def project_state():
    try:
        return workspace_state.state()
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/lakehouse/bootstrap")
def bootstrap():
    try:
        ducklake.bootstrap()
        return {
            "status": "ready",
            "catalog": str(settings.catalog_path),
            "data_path": str(settings.data_path),
        }
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/generate")
def generate(request: GenerateRequest):
    try:
        manifest = generator.generate(request.scenario, request.scale, request.seed)
        ducklake.load_parquet_to_bronze(
            {key: Path(value) for key, value in manifest["files"].items()}
        )
        latest = ducklake.snapshots(1)
        snapshot_id = int(latest[0]["snapshot_id"]) if latest else None
        manifest = generator.mark_bronze_loaded(
            str(manifest["run_id"]),
            snapshot_id,
        )
        return {
            **manifest,
            "bronze_loaded": True,
            "snapshot_id": snapshot_id,
        }
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/lakehouse/catalog")
def catalog():
    try:
        return {"tables": ducklake.catalog()}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/lakehouse/snapshots")
def snapshots(limit: int = Query(default=50, ge=1, le=200)):
    try:
        return {"snapshots": ducklake.snapshots(limit)}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/lakehouse/time-travel", response_model=QueryResult)
def time_travel(
    schema: str = Query(min_length=1),
    table: str = Query(min_length=1),
    snapshot: int = Query(ge=0),
    limit: int = Query(default=100, ge=1, le=2_000),
):
    try:
        columns, rows, truncated = ducklake.preview_at_snapshot(
            schema, table, snapshot, limit
        )
        return QueryResult(
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
        )
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/lakehouse/compare")
def compare_snapshots(
    schema: str = Query(min_length=1),
    table: str = Query(min_length=1),
    base: int = Query(ge=0),
    target: int = Query(ge=0),
):
    try:
        return ducklake.compare_snapshots(schema, table, base, target)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/explore/files")
def files():
    try:
        return {"files": explorer.list_files()}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/explore/import")
async def import_file(request: Request, filename: str = Query(min_length=1, max_length=255)):
    try:
        payload = await request.body()
        return explorer.import_file(filename, payload)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/explore/profile")
def profile_file(
    path: str = Query(min_length=1),
    sheet: str | None = Query(default=None, max_length=200),
):
    try:
        return explorer.profile(path, sheet)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/explore/inspect")
def inspect_file(
    path: str = Query(min_length=1),
    limit: int = Query(default=200, ge=1, le=2_000),
    sheet: str | None = Query(default=None, max_length=200),
):
    try:
        return explorer.inspect(path, limit, sheet)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/dbt/status")
def dbt_status():
    try:
        return dbt.status()
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/dbt/node")
def dbt_node(unique_id: str = Query(min_length=1, max_length=500)):
    try:
        return dbt.node_detail(unique_id)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/dbt/lineage")
def dbt_lineage():
    try:
        return dbt.lineage()
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/dbt/quality")
def dbt_quality():
    try:
        return dbt.quality()
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/dbt/{command}")
def dbt_run(
    command: str,
    selector: str | None = Query(default=None, min_length=1, max_length=200),
):
    try:
        return dbt.run(command, selector)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, detail=f"dbt {command} timed out") from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/charts/board")
def charts_board(board: str = Query(default="executive-sales.yml", min_length=1, max_length=300)):
    try:
        return charts.board(board)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/charts/status")
def charts_status():
    try:
        return charts.status()
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/charts/validate")
def charts_validate(board: str = Query(default="executive-sales.yml")):
    try:
        return charts.validate(board)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, detail="dbt Charts validation timed out") from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/query", response_model=QueryResult)
def query(request: QueryRequest):
    try:
        columns, rows, truncated = ducklake.query(request.sql, request.limit)
        return QueryResult(
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
        )
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/exports")
def list_exports():
    return {"exports": exports.list(), "gold_tables": exports.gold_tables()}


@app.post("/api/exports/artifact")
def export_artifact(request: ArtifactExportRequest):
    try:
        return exports.export(request.mart, request.columns, request.max_rows)
    except (ExportError, ValueError) as exc:
        raise HTTPException(400, detail=str(exc)) from exc


@app.get("/api/exports/{export_id}/{name}")
def export_file(export_id: str, name: str):
    try:
        path = exports.file(export_id, name)
    except ExportError as exc:
        raise HTTPException(404, detail=str(exc)) from exc
    media = "application/json" if path.suffix == ".json" else "application/vnd.apache.parquet"
    return FileResponse(path, media_type=media, filename=path.name)
