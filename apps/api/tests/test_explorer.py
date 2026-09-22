from pathlib import Path

import pytest

from app.config import Settings
from app.services.explorer import ExplorerService


def test_import_file_stays_in_workspace_and_deduplicates(tmp_path: Path):
    service = ExplorerService(Settings(workspace=tmp_path))

    first = service.import_file("../sales.csv", b"id,value\n1,10\n")
    second = service.import_file("sales.csv", b"id,value\n2,20\n")

    assert first["path"] == "imports/sales.csv"
    assert second["path"] == "imports/sales-2.csv"
    assert (tmp_path / first["path"]).read_bytes().startswith(b"id,value")


def test_import_rejects_unsupported_extension(tmp_path: Path):
    service = ExplorerService(Settings(workspace=tmp_path))

    with pytest.raises(ValueError, match="Unsupported file type"):
        service.import_file("payload.exe", b"not allowed")


def test_inspect_profiles_csv_columns(tmp_path: Path):
    service = ExplorerService(Settings(workspace=tmp_path))
    imported = service.import_file(
        "sample.csv",
        b"id,category,value\n1,A,10\n2,A,20\n3,B,\n",
    )

    result = service.inspect(imported["path"], limit=10)
    profile_result = service.profile(imported["path"])

    assert result["columns"] == ["id", "category", "value"]
    assert result["metadata"]["row_count"] == 3
    assert profile_result["columns"] == [
        "column_name",
        "column_type",
        "min",
        "max",
        "approx_unique",
        "avg",
        "std",
        "q25",
        "q50",
        "q75",
        "count",
        "null_percentage",
    ]
    profile = {row[0]: row for row in profile_result["rows"]}
    assert profile["category"][4] == 2
    assert profile["value"][11] != "0.00%"
