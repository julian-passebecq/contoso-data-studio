from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from app.config import Settings
from app.models import GenerateRequest, QueryRequest, QueryResult
from app.services.ducklake import DuckLakeService
from app.services.generator import GeneratorService, SCENARIOS

settings = Settings.load()
ducklake = DuckLakeService(settings)
generator = GeneratorService(settings)
app = FastAPI(title="Contoso Data Studio API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.get("/api/health")
def health():
    return {"status":"ok","workspace":str(settings.workspace)}

@app.get("/api/scenarios")
def scenarios():
    return SCENARIOS

@app.post("/api/lakehouse/bootstrap")
def bootstrap():
    try:
        ducklake.bootstrap()
        return {"status":"ready","catalog":str(settings.catalog_path),"data_path":str(settings.data_path)}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc

@app.post("/api/generate")
def generate(request: GenerateRequest):
    try:
        manifest = generator.generate(request.scenario, request.scale, request.seed)
        ducklake.load_parquet_to_bronze({k:Path(v) for k,v in manifest["files"].items()})
        return {**manifest,"bronze_loaded":True}
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc

@app.get("/api/lakehouse/catalog")
def catalog():
    try:
        return {"tables":ducklake.catalog()}
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc

@app.post("/api/query", response_model=QueryResult)
def query(request: QueryRequest):
    try:
        columns, rows, truncated = ducklake.query(request.sql, request.limit)
        return QueryResult(columns=columns, rows=rows, row_count=len(rows), truncated=truncated)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, detail=str(exc)) from exc
