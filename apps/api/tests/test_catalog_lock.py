from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

from app.config import Settings
from app.services.catalog_lock import catalog_lock
from app.services.dbt_runner import DbtService
from app.services.ducklake import DuckLakeService


def test_catalog_read_waits_for_dbt_subprocess(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTOSO_PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_CATALOG", str(tmp_path / "catalog.sqlite"))
    monkeypatch.setenv("CONTOSO_DUCKLAKE_DATA_PATH", str(tmp_path / "data"))
    settings = Settings(workspace=tmp_path)
    dbt, lake = DbtService(settings), DuckLakeService(settings)
    monkeypatch.setattr("app.services.dbt_runner.shutil.which", lambda _: "dbt")
    started, release = Event(), Event()

    def fake_subprocess(*args, **kwargs):
        started.set()
        assert release.wait(10)
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr("app.services.dbt_runner.subprocess.run", fake_subprocess)
    with ThreadPoolExecutor(2) as pool:
        build = pool.submit(dbt.run, "build")
        assert started.wait(5)
        lock = catalog_lock(lake.settings.catalog_path)
        assert not lock.acquire(blocking=False)
        read = pool.submit(lake.catalog)
        try:
            assert not read.done()
        finally:
            release.set()
        assert build.result(timeout=10)["ok"]
        assert read.result(timeout=60) == []
