import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.models import GenerateRequest, QueryRequest, QueryResult
from app.services.charts import ChartsService
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService
from app.services.generator import GeneratorService, SCENARIOS

settings = Settings.load()
ducklake = DuckLakeService(settings)
explorer = ExplorerService(settings)
generator = GeneratorService(settings)
dbt = DbtService(settings)
charts = ChartsService(settings)

app = FastAPI(title="Contoso Data Studio API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "workspace": str(settings.workspace)}


@app.get("/api/scenarios")
def scenarios():
    return SCENARIOS


@app.get("/api/runs")
def runs(limit: int = Query(default=20, ge=1, le=100)):
    try:
        return {"runs": generator.list_runs(limit)}
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


@app.get("/api/dbt/quality")
def dbt_quality():
    try:
        return dbt.quality()
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.post("/api/dbt/{command}")
def dbt_run(command: str):
    try:
        return dbt.run(command)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, detail=f"dbt {command} timed out") from exc
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
