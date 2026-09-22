import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.models import GenerateRequest, QueryRequest, QueryResult
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService
from app.services.explorer import ExplorerService
from app.services.generator import GeneratorService, SCENARIOS

settings = Settings.load()
ducklake = DuckLakeService(settings)
explorer = ExplorerService(settings)
generator = GeneratorService(settings)
dbt = DbtService(settings)

app = FastAPI(title="Contoso Data Studio API", version="0.3.0")
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


@app.get("/api/explore/files")
def files():
    try:
        return {"files": explorer.list_files()}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc


@app.get("/api/explore/inspect")
def inspect_file(
    path: str = Query(min_length=1),
    limit: int = Query(default=200, ge=1, le=2_000),
):
    try:
        return explorer.inspect(path, limit)
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
