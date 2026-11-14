import pytest
from fastapi.testclient import TestClient

from wallhack.app import create_app
from wallhack.config import Config, load_config


@pytest.fixture
def client():
    cfg = Config(source="simulator", scenario="breathing", background=False)
    app = create_app(cfg)
    app.state.runtime.step_sim(1200)
    with TestClient(app) as c:
        yield c


def test_defaults_are_local():
    assert Config().host == "127.0.0.1" and Config().port == 8000
    assert load_config("/nonexistent.json", env={}).host == "127.0.0.1"


def test_env_override():
    cfg = load_config("/nonexistent.json", env={"WALLHACK_PORT": "9001", "WALLHACK_SOURCE": "simulator"})
    assert cfg.port == 9001 and cfg.source == "simulator"


def test_status(client):
    j = client.get("/api/status").json()
    for k in ("presence", "motion", "breathing_bpm", "source"):
        assert k in j
    assert j["source"] == "simulator" and j["presence"] is True
    assert abs(j["breathing_bpm"] - 15) <= 1


def test_samples_links_zones_events(client):
    s = client.get("/api/samples?limit=10").json()
    assert len(s) == 10 and {"seq", "t", "link", "zone", "rssi"} <= set(s[0])
    assert all(r["link"] == "router-a" for r in client.get("/api/samples?link=router-a&limit=5").json())
    assert len(client.get("/api/links").json()) == 3
    assert {z["zone"] for z in client.get("/api/zones").json()} == {"living_room", "bedroom"}
    ev = client.get("/api/events").json()
    assert any(e["kind"] == "breathing_detected" for e in ev)


def test_settings_roundtrip(client):
    assert client.get("/api/settings").json()["scenario"] == "breathing"
    r = client.post("/api/settings", json={"scenario": "empty", "sensitivity": 1.2})
    assert r.status_code == 200 and r.json()["scenario"] == "empty"
    client.app.state.runtime.step_sim(600)
    assert client.get("/api/status").json()["presence"] is False


def test_settings_validation(client):
    assert client.post("/api/settings", json={"scenario": "bogus"}).status_code == 422
    assert client.post("/api/settings", json={"sensitivity": 99}).status_code == 422
    assert client.post("/api/settings", json={"source": "x"}).status_code == 422


def test_websocket(client):
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
    assert msg["status"]["source"] == "simulator" and msg["samples"]


def test_auto_falls_back_to_simulator(monkeypatch):
    from wallhack import runtime
    monkeypatch.setattr(runtime, "detect_collector", lambda: None)
    app = create_app(Config(source="auto", background=False))
    st = app.state.runtime.status()
    assert st["source"] == "simulator" and "SIMULATED" in st["note"]
