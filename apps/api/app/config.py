from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class Settings:
    workspace: Path

    @classmethod
    def load(cls) -> "Settings":
        configured = os.getenv("CONTOSO_WORKSPACE")
        workspace = Path(configured).expanduser().resolve() if configured else Path(__file__).resolve().parents[4] / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        return cls(workspace=workspace)

    @property
    def catalog_path(self) -> Path:
        return self.workspace / "contoso.ducklake"

    @property
    def data_path(self) -> Path:
        return self.workspace / "contoso.ducklake.files"

    @property
    def staging_path(self) -> Path:
        return self.workspace / "staging"
