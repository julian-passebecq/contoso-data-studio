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
