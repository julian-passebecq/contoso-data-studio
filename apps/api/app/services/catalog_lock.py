"""Coordinate local API connections with dbt's separate SQLite-backed process."""
from pathlib import Path
from threading import Lock, RLock

_registry_lock = Lock()
_catalog_locks = {}


def catalog_lock(path: Path):
    key = str(path.resolve()).casefold()
    with _registry_lock:
        return _catalog_locks.setdefault(key, RLock())
