"""Fabric-style app lab: local stand-ins for a Rayfin operational app (see docs/fabric-apps)."""
from __future__ import annotations

import threading

from app.config import Settings
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService
from app.services.fabric_apps.mirror import MirrorService
from app.services.fabric_apps.model import AppModel, load_model
from app.services.fabric_apps.store import OperationalStore

APP_SLUG = "sales-forecasting"


class FabricAppLab:
    def __init__(self, settings: Settings, start_worker: bool = True, **mirror_options):
        self.settings = settings
        self.model: AppModel = load_model(settings.project_root)
        self.store = OperationalStore(settings.workspace / "fabric-apps" / f"{APP_SLUG}.sqlite", self.model)
        self.ducklake = DuckLakeService(settings)
        self.mirror = MirrorService(settings, self.store, self.ducklake, DbtService(settings).executable, **mirror_options)
        if start_worker:
            self.mirror.start()


_lab: FabricAppLab | None = None
_lab_lock = threading.Lock()


def get_lab() -> FabricAppLab:
    """Created on first use so other API routes never pay for it."""
    global _lab
    with _lab_lock:
        if _lab is None:
            _lab = FabricAppLab(Settings.load())
        return _lab


def set_lab(lab: FabricAppLab | None) -> None:
    """Test hook."""
    global _lab
    with _lab_lock:
        if _lab is not None and _lab is not lab:
            _lab.mirror.stop()
        _lab = lab
