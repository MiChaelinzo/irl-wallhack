import pytest
from fastapi.testclient import TestClient

from wallhack.app import create_app
from wallhack.config import Config, load_config


@pytest.fixture
def client():
    cfg = Config(source="simulator", scenario="breathing", background=False)
    app = create_app(cfg)
    app.state.runtime.step_sim(1200)
    with TestClient(app, base_url="http://localhost") as c:
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
    with client.websocket_connect("ws://localhost/ws") as ws:
        msg = ws.receive_json()
    assert msg["status"]["source"] == "simulator" and msg["samples"]


def test_auto_falls_back_to_simulator(monkeypatch):
    from wallhack import runtime
    monkeypatch.setattr(runtime, "detect_collector", lambda: None)
    app = create_app(Config(source="auto", background=False))
    st = app.state.runtime.status()
    assert st["source"] == "simulator" and "SIMULATED" in st["note"]


def test_foreign_host_header_rejected(client):
    """DNS rebinding: a page on evil.example resolving to 127.0.0.1 must not read presence data."""
    assert client.get("/api/status", headers={"host": "evil.example"}).status_code == 400
    assert client.get("/api/status", headers={"host": "127.0.0.1:8000"}).status_code == 200


def test_websocket_cross_origin_rejected(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://localhost/ws", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()
    with client.websocket_connect("ws://localhost/ws", headers={"origin": "http://localhost"}) as ws:
        assert "status" in ws.receive_json()


def test_settings_post_requires_json_content_type(client):
    r = client.post("/api/settings", content='{"scenario": "empty"}', headers={"content-type": "text/plain"})
    assert r.status_code == 415
    assert client.get("/api/settings").json()["scenario"] == "breathing"
    assert client.post("/api/settings", content="not json", headers={"content-type": "application/json"}).status_code == 422


def test_explicit_real_fails_loudly(monkeypatch):
    from wallhack import runtime
    monkeypatch.setattr(runtime, "detect_collector", lambda: None)
    with pytest.raises(runtime.SourceUnavailableError):
        create_app(Config(source="real", background=False))


def test_settings_to_real_rejected_and_reverted(monkeypatch):
    from wallhack import runtime
    monkeypatch.setattr(runtime, "detect_collector", lambda: None)
    cfg = Config(source="simulator", scenario="breathing", background=False)
    with TestClient(create_app(cfg), base_url="http://localhost") as c:
        r = c.post("/api/settings", json={"source": "real"})
        assert r.status_code == 422 and "real" in r.json()["detail"]
        assert c.get("/api/settings").json()["source"] == "simulator"
        assert c.get("/api/status").json()["source"] == "simulator"


def test_calibrate_resets_baseline(client):
    rt = client.app.state.runtime
    seq = rt.seq
    assert client.get("/api/events").json()
    r = client.post("/api/calibrate")
    assert r.status_code == 200 and r.json() == {"calibrated": True}
    assert client.get("/api/events").json() == []
    assert rt.seq == seq  # history and sequence numbers survive, clients stay in sync


def test_calibrate_rejects_cross_origin(client):
    assert client.post("/api/calibrate", headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.post("/api/settings", json={"scenario": "empty"},
                       headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.post("/api/calibrate", headers={"Origin": "http://localhost"}).status_code == 200


def test_environment_endpoint_is_simulated_in_simulator_mode(client):
    env = client.get("/api/environment").json()
    assert env["simulated"] is True and env["reading"]["simulated"] is True
    assert env["aqi"]["aqi"] >= 0 and env["aqi"]["category"]
    assert set(env["ratings"]) == {"particulates", "co2", "tvoc", "hcho", "humidity"}
    assert env["overall"]["level"] in ("good", "fair", "poor", "bad")
    assert env["sensors"] == {}


def test_vitals_endpoint(client):
    v = client.get("/api/vitals").json()
    assert v["simulated"] is True and v["activity"] == "still"
    assert abs(v["breathing_bpm"] - 15) <= 1 and abs(v["heart_bpm"] - 68) <= 3
    assert v["heart_supported"] is True


def test_status_and_websocket_carry_environment_and_vitals(client):
    st = client.get("/api/status").json()
    assert st["environment"]["simulated"] is True and st["vitals"]["heart_bpm"] is not None
    with client.websocket_connect("ws://localhost/ws") as ws:
        msg = ws.receive_json()
    assert msg["status"]["environment"]["simulated"] is True
    assert msg["status"]["vitals"]["activity"] == "still"


def test_environment_and_vitals_keep_host_protection(client):
    for path in ("/api/environment", "/api/vitals"):
        assert client.get(path, headers={"host": "evil.example"}).status_code == 400


def test_sensor_config_from_environment():
    cfg = load_config("/nonexistent.json", env={"WALLHACK_SENSORS": "pms5003,scd4x", "WALLHACK_I2C_BUS": "3",
                                                 "WALLHACK_SERIAL_PMS": "/dev/ttyAMA0"})
    assert cfg.sensor_names() == ("pms5003", "scd4x") and cfg.i2c_bus == 3 and cfg.serial_pms == "/dev/ttyAMA0"
    with pytest.raises(ValueError):
        load_config("/nonexistent.json", env={"WALLHACK_SENSORS": "bogus"})
