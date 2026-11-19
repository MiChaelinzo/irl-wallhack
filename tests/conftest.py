import pytest

from wallhack import config


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """Every test gets its own data directory so nothing writes into the repository."""
    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", str(tmp_path / "data"))
