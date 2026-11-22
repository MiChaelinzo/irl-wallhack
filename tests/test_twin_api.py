import json
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


def test_rf_coverage_band_and_mode(client):
    j = client.get("/api/rf/coverage?floor=ground&cell_m=1&band=5&mode=multipath").json()
    assert j["band"] == "5" and j["mode"] == "multipath" and "MODEL ESTIMATE" in j["label"]
    base = client.get("/api/rf/coverage?floor=ground&cell_m=1").json()
    assert "mode" not in base and j["rssi"] != base["rssi"]


def test_rf_coverage_rejects_bad_band_and_mode(client):
    assert client.get("/api/rf/coverage?band=60").status_code == 422
    assert client.get("/api/rf/coverage?mode=magic").status_code == 422


def test_rf_config_endpoint(client):
    j = client.get("/api/rf/config").json()
    assert set(j["bands"]) == {"2.4", "5", "6"} and "drywall" in j["materials"] and "typical" in j["source"].lower()


def test_planner_route_does_not_error(client):
    assert client.get("/planner").status_code in (200, 404)


def test_put_twin_accepts_5000_walls_under_the_body_cap(client):
    import json
    from wallhack.app import MAX_BODY_BYTES
    t = sample_twin()
    f = t["floors"][0]
    f["width_m"] = f["depth_m"] = 200
    f["walls"] = [{"id": f"w{i}", "x1": 1.2345 + (i % 100) * 1.5, "y1": 1.2345 + (i // 100) * 3.25,
                   "x2": 2.5678 + (i % 100) * 1.5, "y2": 1.2345 + (i // 100) * 3.25, "kind": "interior"} for i in range(5000)]
    f["openings"] = [{"id": f"o{i}", "kind": "door", "wall": f"w{i}", "pos": 0.2, "width": 0.9} for i in range(5000)]
    size = len(json.dumps(t, separators=(",", ":")))
    assert size < MAX_BODY_BYTES * 0.9, size     # leaves room for rooms, APs and a small background
    assert client.put("/api/twin", json=t).status_code == 200
    assert len(client.get("/api/twin").json()["floors"][0]["walls"]) == 5000


def _twin_with_backgrounds(chars_per_floor):
    t = sample_twin()
    for f in t["floors"]:
        f["background"] = "data:image/png;base64," + "A" * chars_per_floor
    return t


def test_twin_with_max_size_backgrounds_exceeds_1mb_but_is_accepted(client):
    from wallhack import rfmodel
    t = _twin_with_backgrounds(rfmodel.LIMITS["max_background_chars"] - 100)
    body = json.dumps(t)
    assert len(body) > 1_000_000
    r = client.put("/api/twin", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 200


def test_twin_body_above_the_derived_limit_is_413_and_other_routes_keep_1mb(client):
    from wallhack.app import MAX_BODY_BYTES, MAX_TWIN_BODY_BYTES
    assert MAX_BODY_BYTES == 1_000_000 and MAX_TWIN_BODY_BYTES > MAX_BODY_BYTES
    big = json.dumps({"name": "x", "pad": "A" * MAX_TWIN_BODY_BYTES})
    assert client.put("/api/twin", content=big, headers={"content-type": "application/json"}).status_code == 413
    mid = json.dumps({"pad": "A" * (MAX_BODY_BYTES + 10)})
    assert client.post("/api/settings", content=mid, headers={"content-type": "application/json"}).status_code == 413
