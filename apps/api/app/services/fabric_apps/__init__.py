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


def set_lab(lab: FabricAppLab | None, wait: bool = True) -> None:
    """Replace the lab (test hook; workspace switch). wait=False stops the old mirror in the background."""
    global _lab
    with _lab_lock:
        previous, _lab = _lab, lab
    if previous is not None and previous is not lab:
        if wait:
            previous.mirror.stop()
        else:
            threading.Thread(target=previous.mirror.stop, name="fabric-app-mirror-stop", daemon=True).start()
