from typing import Any, Literal

from pydantic import BaseModel, Field


ScenarioId = Literal[
    "retail-baseline",
    "online-migration",
    "margin-pressure",
    "logistics-delays",
    "currency-exposure",
]


class GenerateRequest(BaseModel):
    scenario: ScenarioId = "retail-baseline"
    scale: int = Field(default=10_000, ge=100, le=2_000_000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    limit: int = Field(default=500, ge=1, le=5_000)


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
