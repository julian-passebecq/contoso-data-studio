from typing import Any, Literal

from pydantic import BaseModel, Field


ScenarioId = Literal[
    "retail-baseline",
    "online-migration",
    "margin-pressure",
    "logistics-delays",
    "currency-exposure",
    "foil-energy-risk",
    "foil-investment",
    "foil-sensitivity",
]


class GenerateRequest(BaseModel):
    scenario: ScenarioId = "retail-baseline"
    scale: int = Field(default=10_000, ge=100, le=2_000_000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    limit: int = Field(default=500, ge=1, le=5_000)


LineageConfidence = Literal["verified", "inferred", "unresolved"]


class LineageRelation(BaseModel):
    catalog: str | None
    schema_: str | None = Field(alias="schema", serialization_alias="schema")
    table: str
    layer: str | None
    dbt_model: str | None
    columns: list[str]
    at: list[dict[str, Any]] = Field(default_factory=list)
    confidence: LineageConfidence
    note: str = ""

    model_config = {"populate_by_name": True}


class QueryLineage(BaseModel):
    relations: list[LineageRelation]
    method: str
    confidence: LineageConfidence
    note: str | None = None


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    # Additive: relations and columns the statement read, resolved by DuckDB (POST /api/query only).
    lineage: QueryLineage | None = None


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WorkspaceRestore(BaseModel):
    backup: str = Field(min_length=5, max_length=200)
    name: str = Field(min_length=1, max_length=80)


class ArtifactExportRequest(BaseModel):
    mart: str = Field(min_length=1, max_length=80)
    columns: list[str] | None = Field(default=None, max_length=40)
    max_rows: int = Field(default=5_000, ge=1, le=10_000)
