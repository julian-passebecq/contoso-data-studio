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
        manifest = generator.mark_bronze_loaded(str(manifest["run_id"]))
        return {**manifest, "bronze_loaded": True}
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
