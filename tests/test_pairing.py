import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from wallhack import pairing, qr
from wallhack.app import create_app
from wallhack.config import Config, load_config

REMOTE = ("192.168.1.50", 40000)
LOCAL = ("127.0.0.1", 40000)


def make(lan, client=REMOTE, base="http://192.168.1.10:8000", **kw):
    app = create_app(Config(source="simulator", background=False, lan=lan, **kw))
    return app, TestClient(app, base_url=base, client=client)


def test_default_is_local_only():
    cfg = Config()
    assert cfg.lan is False and cfg.host == "127.0.0.1" and cfg.bind_host() == "127.0.0.1"
    assert load_config("/nonexistent.json", env={}).bind_host() == "127.0.0.1"
    app = create_app(Config(source="simulator", background=False))
    assert not hasattr(app.state, "pair_token")
    with TestClient(app, base_url="http://evil.example") as c:   # DNS rebinding guard still active
        assert c.get("/api/status").status_code == 400


def test_lan_opt_in_binds_all_interfaces():
    assert Config(lan=True).bind_host() == "0.0.0.0"
    assert load_config("/nonexistent.json", env={"WALLHACK_LAN": "1"}).lan is True
    assert Config(lan=True, host="10.0.0.5").bind_host() == "10.0.0.5"


def test_unauthenticated_remote_requests_are_rejected():
    app, c = make(True)
    with c:
        for path in ("/api/status", "/api/twin", "/", "/api/pair", "/static/app.js"):
            assert c.get(path).status_code == 401, path
        assert c.put("/api/twin", json={}).status_code == 401
        assert c.get("/api/status", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert c.get("/pair?token=wrong").status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/ws"):
                pass


def test_pairing_cookie_and_bearer_grant_access():
    app, c = make(True)
    token = app.state.pair_token
    with c:
        r = c.get(f"/pair?token={token}", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/"
        cookie = r.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie
        assert c.get("/api/status").status_code == 200       # httpx keeps the cookie
        # the test client does not replay its cookie jar on WebSockets; browsers do
        with c.websocket_connect("/ws", headers={"cookie": f"{pairing.COOKIE_NAME}={token}"}) as ws:
            assert "status" in ws.receive_json()
    app2, c2 = make(True)
    with c2:
        assert c2.get("/api/status", headers={"Authorization": f"Bearer {app2.state.pair_token}"}).status_code == 200


def test_pair_url_is_loopback_only_and_off_by_default(monkeypatch):
    monkeypatch.setattr(pairing, "lan_address", lambda: "192.168.1.10")
    app, host = make(True, client=LOCAL)
    with host:
        j = host.get("/api/pair").json()
        assert j["url"] == f"http://192.168.1.10:8000/pair?token={app.state.pair_token}"
        assert host.get("/api/status").status_code == 200    # the host machine needs no token
        assert j["qr"] == qr.encode(j["url"]) and "token=" + app.state.pair_token in j["url"]
    _, off = make(False, client=LOCAL, base="http://localhost")
    with off:
        assert off.get("/api/pair").status_code == 404
        assert off.get("/pair?token=x").status_code == 403


def test_loopback_client_with_foreign_host_is_refused(monkeypatch):
    """DNS rebinding: the page reaches 127.0.0.1 but its Host header is the attacker's name."""
    monkeypatch.setattr(pairing, "lan_address", lambda: "192.168.1.10")
    app, evil = make(True, client=LOCAL, base="http://evil.example")
    with evil:
        for path in ("/api/pair", "/api/status", "/"):
            assert evil.get(path).status_code == 400, path
        assert evil.put("/api/twin", json={}).status_code == 400
        with pytest.raises(WebSocketDisconnect):
            with evil.websocket_connect("/ws"):
                pass
    for base in ("http://localhost:8000", "http://127.0.0.1:8000", "http://192.168.1.10:8000"):
        _, owner = make(True, client=LOCAL, base=base)
        with owner:
            assert owner.get("/api/status").status_code == 200, base


def test_pair_url_refused_when_origin_header_present(monkeypatch):
    monkeypatch.setattr(pairing, "lan_address", lambda: "192.168.1.10")
    _, host = make(True, client=LOCAL)
    with host:
        assert host.get("/api/pair", headers={"Origin": "http://evil.example"}).status_code == 403
        assert host.get("/api/pair").status_code == 200


def test_host_name_parsing():
    assert pairing.host_name("LocalHost:8000") == "localhost"
    assert pairing.host_name("[::1]:8000") == "::1"
    assert pairing.host_name(None) == ""


def test_oversized_json_bodies_are_refused():
    app = create_app(Config(source="simulator", background=False))
    big = b'{"x":"' + b"a" * 1_100_000 + b'"}'
    with TestClient(app, base_url="http://localhost") as c:
        h = {"Content-Type": "application/json"}
        assert c.put("/api/twin", content=big, headers=h).status_code == 422   # under the twin's own, larger limit
        assert c.post("/api/insights/explain", content=big, headers=h).status_code == 413
        assert c.post("/api/settings", content=big, headers=h).status_code == 413
        assert c.put("/api/twin", content=b"{bad", headers=h).status_code == 422


def test_llm_provider_lists_match():
    from wallhack import config, llm
    assert config.LLM_PROVIDERS == llm.PROVIDERS


def test_tokens_are_random_and_compared_safely():
    assert pairing.new_token() != pairing.new_token() and len(pairing.new_token()) >= 32
    assert pairing.token_matches("abc", "abc") and not pairing.token_matches("abd", "abc")
    assert not pairing.token_matches(None, "abc") and not pairing.token_matches("", "")


def test_cross_origin_post_still_refused_in_lan_mode():
    app, c = make(True)
    with c:
        h = {"Authorization": f"Bearer {app.state.pair_token}", "Origin": "http://evil.example"}
        assert c.post("/api/calibrate", headers=h).status_code == 403


def test_lan_address_returns_an_ip():
    assert pairing.lan_address().count(".") == 3


def test_health_mode_lists_unsupported_metrics():
    app = create_app(Config(source="simulator", scenario="breathing", background=False))
    app.state.runtime.step_sim(1200)
    with TestClient(app, base_url="http://localhost") as c:
        j = c.get("/api/health").json()
    assert {u["id"] for u in j["unsupported"]} == {"mood", "perspiration", "thoughts", "through_wall_imaging"}
    assert all(u["supported"] is False and u["reason"] for u in j["unsupported"])
    assert {s["id"] for s in j["supported"]} >= {"presence", "breathing", "heart_rate", "air_quality"}
    assert j["simulated"] is True and "Not a medical device" in j["disclaimer"]
    assert j["vitals"]["breathing_bpm"] is not None and "co2" in j["air"]
