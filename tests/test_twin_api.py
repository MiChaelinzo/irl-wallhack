import pytest
from fastapi.testclient import TestClient

from wallhack.app import create_app
from wallhack.config import Config
from wallhack.twin import sample_twin


@pytest.fixture
def client():
    app = create_app(Config(source="simulator", background=False))
    with TestClient(app, base_url="http://localhost") as c:
        yield c


def test_get_twin_defaults_to_sample(client):
    assert client.get("/api/twin").json()["sample"] is True


def test_put_twin_persists(client):
    t = sample_twin()
    t["name"] = "Flat"
    r = client.put("/api/twin", json=t)
    assert r.status_code == 200 and r.json()["name"] == "Flat"
    assert client.get("/api/twin").json()["sample"] is False
    app2 = create_app(Config(source="simulator", background=False, data_dir=client.app.state.runtime.config.data_dir))
    with TestClient(app2, base_url="http://localhost") as c2:
        assert c2.get("/api/twin").json()["name"] == "Flat"


def test_put_twin_rejects_invalid_cross_origin_and_non_json(client):
    bad = sample_twin()
    bad["floors"] = []
    r = client.put("/api/twin", json=bad)
    assert r.status_code == 422 and "floors" in r.json()["detail"]
    assert client.put("/api/twin", json=sample_twin(), headers={"origin": "http://evil.example"}).status_code == 403
    assert client.put("/api/twin", content="x", headers={"content-type": "text/plain"}).status_code == 415
    assert client.put("/api/twin", content="{bad", headers={"content-type": "application/json"}).status_code == 422


def test_rf_coverage_endpoint(client):
    j = client.get("/api/rf/coverage?floor=upper&cell_m=1").json()
    assert j["floor"] == "upper" and j["cols"] == 10 and "ESTIMATE" in j["label"]
    assert client.get("/api/rf/coverage?floor=zzz").status_code == 404
    assert client.get("/api/rf/coverage?cell_m=0").status_code == 422
