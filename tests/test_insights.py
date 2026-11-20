import copy
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from wallhack import insights, llm, scores
from wallhack.app import create_app
from wallhack.config import Config
from wallhack.twin import sample_twin


def rows(signal, occupancy=None, n=20):
    return [{"t": i * 5.0, "signal_dbm": signal[i] if isinstance(signal, list) else signal,
             "occupancy": (occupancy[i] if occupancy else 0)} for i in range(n)]


def test_signal_drop_levels():
    flat = rows(-50.0)
    assert insights.signal_drop(flat) is None
    warn = rows([-50.0] * 10 + [-56.0] * 10)
    assert insights.signal_drop(warn)["severity"] == "warning"
    danger = rows([-50.0] * 10 + [-65.0] * 10)
    f = insights.signal_drop(danger)
    assert f["severity"] == "danger" and f["evidence"]["drop_pct"] == 30.0
    assert insights.signal_drop(rows(-50.0, n=3)) is None


def test_occupancy_trend():
    assert insights.occupancy_trend(rows(-50.0, [0] * 20)) is None
    f = insights.occupancy_trend(rows(-50.0, [0] * 10 + [1] * 10))
    assert f["id"] == "occupancy_trend" and "rising" in f["title"]
    assert "falling" in insights.occupancy_trend(rows(-50.0, [1] * 10 + [0] * 10))["title"]


def test_air_findings():
    st = {"co2": {"value": 1800, "unit": "ppm", "status": "Warning"},
          "pm25": {"value": 90, "unit": "ug/m3", "status": "Danger"},
          "humidity": {"value": 45, "unit": "%", "status": "Healthy"}}
    out = {f["id"]: f for f in insights.air_findings(st)}
    assert set(out) == {"air_co2", "air_pm25"}
    assert out["air_pm25"]["severity"] == "danger" and "window" in out["air_co2"]["recommendation"]
    assert insights.air_findings(None) == []


def test_air_peaks_report_past_excursions_only():
    r = [{"t": float(i), "pm25": v, "co2": 500.0} for i, v in enumerate([5, 90, 40, 6])]
    found = insights.air_peaks(r, None)
    assert [f["id"] for f in found] == ["air_peak_pm25"]
    assert found[0]["evidence"]["peak"] == 90 and found[0]["severity"] == "info"
    now_bad = {"pm25": {"value": 60, "unit": "ug/m3", "status": "Danger"}}
    assert insights.air_peaks(r, now_bad) == []
    assert insights.air_peaks([{"t": 0.0, "pm25": None, "co2": None}], None) == []


def test_ap_attenuation_uses_rf_model():
    t = sample_twin()
    t["floors"][0]["aps"][0].update(x=9.0, y=2.0)           # kitchen
    t["floors"][0]["sensors"][1].update(x=1.0, y=2.0)       # living room, one interior wall (4 dB) away
    assert insights.ap_attenuation(t) == []
    t["floors"][0]["walls"][4]["kind"] = "exterior"         # g-i1 becomes a 9 dB wall
    found = insights.ap_attenuation(t)
    assert [f["evidence"]["wall_loss_db"] for f in found] == [9.0]
    assert "closer" in found[0]["recommendation"]


def test_coverage_finding_recommends_a_move_and_is_deterministic():
    t = sample_twin()
    t["floors"][1]["aps"] = []
    t["floors"][0]["aps"][0].update(x=0.5, y=0.5, tx_dbm=0.0)
    a = insights.coverage_findings(t)
    assert a == insights.coverage_findings(copy.deepcopy(t))
    assert [f["id"] for f in a] == ["coverage_ground"]
    assert a[0]["recommendation"].startswith("Move access point router")
    assert insights.coverage_findings(sample_twin()) == []


def test_build_insights_is_sorted_and_stable():
    st = {"pm25": {"value": 90, "unit": "ug/m3", "status": "Danger"}, "co2": {"value": 1800, "unit": "ppm", "status": "Warning"}}
    r = rows([-50.0] * 10 + [-56.0] * 10, [0] * 10 + [1] * 10)
    a = insights.build_insights(r, st, sample_twin())
    assert a == insights.build_insights(r, st, sample_twin())
    sev = [insights.SEVERITIES.index(f["severity"]) for f in a]
    assert sev == sorted(sev, reverse=True)


# ---- scores ------------------------------------------------------------------------
def test_score_bands_and_trend():
    assert [scores.band(v) for v in (80, 75, 60, 50, 10, None)] == ["green", "green", "yellow", "yellow", "red", "grey"]
    assert scores.trend(80, 70) == "up" and scores.trend(70, 80) == "down" and scores.trend(71, 70) == "flat"
    assert scores.trend(None, 5) is None and scores.trend(5, None) is None


def test_compute_scores_values():
    links = [{"rssi": -40.0, "presence": True}, {"rssi": -90.0, "presence": True}, {"rssi": -65.0, "presence": False}]
    status = {"source": "real", "collectors": ["ping"], "stale_s": 0.0,
              "environment": {"status": {"co2": {"status": "Healthy"}, "pm25": {"status": "Danger"}}, "sensors": {"scd4x": {"state": "error"}}}}
    out = {s["id"]: s for s in scores.compute_scores(status, 88.0, links, {"coverage": 70.0})}
    assert out["signal_health"]["value"] == 50.0
    assert out["occupancy_confidence"]["value"] == 66.7
    assert out["environment"]["value"] == 40.0  # 0.5 * mean(100, 20) + 0.5 * 20
    assert out["coverage"]["trend"] == "up" and out["coverage"]["band"] == "green"
    assert out["hardware_status"]["value"] == 80.0
    none = {s["id"]: s for s in scores.compute_scores({"source": "simulator", "collectors": []}, None, [])}
    assert none["coverage"]["band"] == "grey" and none["hardware_status"]["value"] == scores.SIMULATED_HARDWARE_SCORE


# ---- llm against a mocked local HTTP server ---------------------------------------------
class _Mock(BaseHTTPRequestHandler):
    seen = []
    reply = {}

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Mock.seen.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
        status, payload = _Mock.reply.get(self.path.split("?")[0], (404, {}))
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture
def mock_server():
    _Mock.seen, _Mock.reply = [], {}
    srv = HTTPServer(("127.0.0.1", 0), _Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}", _Mock
    srv.shutdown()
    srv.server_close()


FINDINGS = [{"id": "x", "severity": "warning", "title": "High CO2", "detail": "CO2 is 1800 ppm.", "recommendation": "Open a window."}]


def test_ollama_and_llamacpp_shapes(mock_server):
    url, m = mock_server
    m.reply = {"/api/chat": (200, {"message": {"content": " Open a window. "}}),
               "/v1/chat/completions": (200, {"choices": [{"message": {"content": "Ventilate."}}]})}
    a = llm.explain(FINDINGS, "ollama", endpoint=url)
    assert a["explanation"] == "Open a window." and a["off_device"] is False
    assert m.seen[0]["body"]["stream"] is False and "CO2 is 1800 ppm" in m.seen[0]["body"]["messages"][1]["content"]
    assert llm.explain(FINDINGS, "llamacpp", endpoint=url)["explanation"] == "Ventilate."


def test_openai_and_azure_use_env_keys_and_need_confirmation(mock_server):
    url, m = mock_server
    m.reply = {"/v1/chat/completions": (200, {"choices": [{"message": {"content": "ok"}}]}),
               "/openai/deployments/dep/chat/completions": (200, {"choices": [{"message": {"content": "az"}}]})}
    env = {"OPENAI_API_KEY": "sk-test-secret", "AZURE_OPENAI_API_KEY": "az-secret"}
    with pytest.raises(llm.LlmError, match="off-device"):
        llm.explain(FINDINGS, "openai", endpoint=url, env=env)
    assert m.seen == []  # nothing was sent without confirmation
    out = llm.explain(FINDINGS, "openai", endpoint=url, env=env, confirm_off_device=True)
    assert out["off_device"] is True and "sk-test-secret" not in json.dumps(out)
    assert m.seen[0]["headers"]["Authorization"] == "Bearer sk-test-secret"
    out = llm.explain(FINDINGS, "azure", model="dep", endpoint=url, env=env, confirm_off_device=True)
    assert out["explanation"] == "az" and {k.lower(): v for k, v in m.seen[1]["headers"].items()}["api-key"] == "az-secret"
    assert "api-version=" in m.seen[1]["path"]


def test_llm_errors_never_leak_keys(mock_server):
    url, m = mock_server
    env = {"OPENAI_API_KEY": "sk-test-secret"}
    with pytest.raises(llm.LlmError, match="not set"):
        llm.explain(FINDINGS, "openai", env={}, confirm_off_device=True)
    m.reply = {"/v1/chat/completions": (500, {})}
    with pytest.raises(llm.LlmError) as e:
        llm.explain(FINDINGS, "openai", endpoint=url, env=env, confirm_off_device=True)
    assert "sk-test-secret" not in str(e.value) and "500" in str(e.value)
    m.reply = {"/v1/chat/completions": (200, {"weird": 1})}
    with pytest.raises(llm.LlmError, match="unexpected shape"):
        llm.explain(FINDINGS, "llamacpp", endpoint=url)
    with pytest.raises(llm.LlmError, match="could not reach"):
        llm.explain(FINDINGS, "ollama", endpoint="http://127.0.0.1:1", timeout_s=1)


def test_llm_off_and_bad_config():
    with pytest.raises(llm.LlmError, match="off"):
        llm.explain(FINDINGS, "")
    with pytest.raises(llm.LlmError):
        llm.disclosure("skynet")
    with pytest.raises(llm.LlmError, match="no findings"):
        llm.explain([], "ollama")
    with pytest.raises(llm.LlmError, match="http"):
        llm.explain(FINDINGS, "ollama", endpoint="file:///etc/passwd")
    assert llm.disclosure("openai")["off_device"] and not llm.disclosure("ollama")["off_device"]
    with pytest.raises(ValueError):
        Config(llm_provider="bogus").validate()


# ---- API ----------------------------------------------------------------------------------
@pytest.fixture
def client():
    app = create_app(Config(source="simulator", scenario="demo", background=False))
    app.state.runtime.step_sim(3000)
    with TestClient(app, base_url="http://localhost") as c:
        yield c


def test_insights_and_scores_endpoints(client):
    j = client.get("/api/insights").json()
    assert j["engine"] == "rules" and j["llm"]["enabled"] is False and j["history_rows"] > 10
    assert all({"id", "severity", "title", "detail", "evidence"} <= set(f) for f in j["insights"])
    s = client.get("/api/scores").json()["scores"]
    assert [x["id"] for x in s] == list(scores.SCORE_IDS)
    assert all(x["band"] in ("green", "yellow", "red", "grey") for x in s)


def test_explain_endpoint_disabled_by_default_and_checks_origin(client):
    r = client.post("/api/insights/explain", json={})
    assert r.status_code == 409 and "off" in r.json()["detail"]
    assert client.post("/api/insights/explain", json={}, headers={"origin": "http://evil.example"}).status_code == 403
    assert client.post("/api/insights/explain", content="x", headers={"content-type": "text/plain"}).status_code == 415


def test_explain_endpoint_with_mock_llm(mock_server, monkeypatch):
    url, m = mock_server
    m.reply = {"/api/chat": (200, {"message": {"content": "Plain words."}})}
    app = create_app(Config(source="simulator", scenario="demo", background=False, llm_provider="ollama", llm_endpoint=url))
    rt = app.state.runtime
    rt.step_sim(3000)
    rt.twin["floors"][0]["aps"][0].update(x=9.0, y=2.0)
    rt.twin["floors"][0]["sensors"][1].update(x=1.0, y=2.0)
    rt.twin["floors"][0]["walls"][4]["kind"] = "exterior"
    with TestClient(app, base_url="http://localhost") as c:
        assert c.get("/api/insights").json()["insights"]
        r = c.post("/api/insights/explain", json={})
        assert r.status_code == 200 and r.json()["explanation"] == "Plain words."


def test_trend_appears_after_marks(client):
    rt = client.app.state.runtime
    first = client.get("/api/scores").json()["scores"]
    assert all(s["trend"] is None for s in first)
    rt.step_sim(300)
    second = client.get("/api/scores").json()["scores"]
    assert all(s["trend"] in (None, "up", "down", "flat") for s in second)
