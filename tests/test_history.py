import pytest
from fastapi.testclient import TestClient

from wallhack.app import create_app
from wallhack.config import Config
from wallhack.environment import EnvironmentReading, environment_report, metric_statuses
from wallhack.history import History
from wallhack.runtime import Runtime


def test_record_and_query_buckets(tmp_path):
    h = History(str(tmp_path / "h.db"))
    for i in range(10):
        h.record(float(i), occupancy=i >= 5, co2=400 + i)
    rows = h.query(0, None, 5)
    assert [r["t"] for r in rows] == [0, 5]
    assert rows[0]["occupancy"] == 0 and rows[1]["occupancy"] == 1
    assert rows[0]["co2"] == 402.0 and rows[0]["pm25"] is None
    assert [r["t"] for r in h.query(3, 6, 1)] == [3, 4, 5, 6]


def test_retention_limit_prunes_oldest(tmp_path):
    h = History(str(tmp_path / "h.db"), max_rows=5)
    for i in range(12):
        h.record(float(i))
    assert h.count() == 5
    assert h.query(0, None, 1)[0]["t"] == 7


def test_sessions_are_separate_and_persist(tmp_path):
    path = str(tmp_path / "h.db")
    a = History(path)
    a.record(1.0, co2=500)
    a.close()
    b = History(path)
    assert b.session == a.session + 1
    assert b.query() == []
    assert b.query(session=a.session)[0]["co2"] == 500.0


def test_bad_arguments(tmp_path):
    h = History(":memory:")
    with pytest.raises(ValueError):
        h.record(0, bogus=1)
    with pytest.raises(ValueError):
        h.query(step=0)
    with pytest.raises(ValueError):
        h.query(5, 1)
    with pytest.raises(ValueError):
        History(":memory:", max_rows=0)


def test_runtime_samples_history_each_step():
    rt = Runtime(Config(source="simulator", scenario="breathing", background=False, history_step_s=5.0))
    rt.step_sim(600)  # 60 s of sensing time at 10 Hz
    rows = rt.history.query(0, None, 5)
    assert 11 <= len(rows) <= 13
    last = rows[-1]
    assert last["occupancy"] == 1 and last["co2"] is not None and last["signal_dbm"] is not None
    assert last["breathing_bpm"] is not None


def test_runtime_history_is_deterministic():
    def run():
        rt = Runtime(Config(source="simulator", scenario="demo", seed=3, background=False))
        rt.step_sim(900)
        return rt.history.query(0, None, 5)
    assert run() == run()


def test_history_can_be_disabled():
    rt = Runtime(Config(source="simulator", background=False, history_enabled=False))
    rt.step_sim(100)
    assert rt.history is None


def test_reconfigure_starts_new_session():
    rt = Runtime(Config(source="simulator", scenario="walking", background=False))
    rt.step_sim(300)
    rt.update_settings(scenario="empty")
    assert rt.history.query() == []
    rt.step_sim(100)
    assert rt.history.query()


def test_history_api():
    app = create_app(Config(source="simulator", scenario="breathing", background=False))
    app.state.runtime.step_sim(600)
    with TestClient(app, base_url="http://localhost") as c:
        j = c.get("/api/history?from=10&to=30&step=10").json()
        assert [r["t"] for r in j["rows"]] == [10, 20, 30]
        assert c.get("/api/history?step=0").status_code == 422
        assert c.get("/api/history?from=9&to=1").status_code == 422
    off = create_app(Config(source="simulator", background=False, history_enabled=False))
    with TestClient(off, base_url="http://localhost") as c:
        assert c.get("/api/history").status_code == 404


def test_config_validation():
    with pytest.raises(ValueError):
        Config(history_step_s=0).validate()
    with pytest.raises(ValueError):
        Config(history_max_rows=0).validate()


# ---- Healthy / Warning / Danger ----------------------------------------------------
def test_metric_statuses():
    r = EnvironmentReading(co2=900, humidity_pct=45, temperature_c=22, tvoc_ppb=100, pm25=5, pm10=20)
    st = metric_statuses(r)
    assert {k: v["status"] for k, v in st.items()} == {k: "Healthy" for k in
                                                       ("co2", "humidity", "temperature", "tvoc", "pm25", "pm10", "aqi")}
    bad = metric_statuses(EnvironmentReading(co2=1500, humidity_pct=75, temperature_c=28, tvoc_ppb=3000, pm25=60, pm10=200))
    assert bad["co2"]["status"] == "Warning" and bad["humidity"]["status"] == "Danger"
    assert bad["temperature"]["status"] == "Warning" and bad["tvoc"]["status"] == "Danger"
    assert bad["pm25"]["status"] == "Danger" and bad["pm10"]["status"] == "Danger" and bad["aqi"]["status"] == "Danger"
    assert metric_statuses(EnvironmentReading())["co2"] is None
    assert metric_statuses(EnvironmentReading(temperature_c=10))["temperature"]["status"] == "Danger"


def test_status_in_environment_report_and_api():
    assert "status" in environment_report(EnvironmentReading(co2=500))
    app = create_app(Config(source="simulator", background=False))
    app.state.runtime.step_sim(100)
    with TestClient(app, base_url="http://localhost") as c:
        assert c.get("/api/environment").json()["status"]["co2"]["status"] in ("Healthy", "Warning", "Danger")
