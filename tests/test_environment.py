import pytest

from wallhack.environment import (EnvironmentReading, dew_point_c, environment_report, heat_index_c,
                                  overall_air_quality, rate_co2, rate_hcho, rate_humidity, rate_tvoc,
                                  us_epa_aqi)


@pytest.mark.parametrize("pm25,aqi", [
    (0.0, 0), (9.0, 50), (9.1, 51), (35.4, 100), (35.5, 101), (55.4, 150), (55.5, 151),
    (125.4, 200), (125.5, 201), (225.4, 300), (225.5, 301), (325.4, 500), (900.0, 500),
])
def test_pm25_breakpoints(pm25, aqi):
    assert us_epa_aqi(pm25, None)["aqi"] == aqi


@pytest.mark.parametrize("pm10,aqi", [(0, 0), (54, 50), (55, 51), (154, 100), (155, 101),
                                       (424, 300), (425, 301), (504, 400), (505, 401), (604, 500), (1000, 500)])
def test_pm10_breakpoints(pm10, aqi):
    assert us_epa_aqi(None, pm10)["aqi"] == aqi


def test_pm25_is_truncated_not_rounded():
    assert us_epa_aqi(9.04, None)["aqi"] == 50   # truncates to 9.0


def test_aqi_takes_worse_pollutant_and_names_category():
    r = us_epa_aqi(5.0, 300.0)
    assert r["pollutant"] == "pm10" and r["category"] == "Unhealthy"


def test_aqi_missing_data():
    assert us_epa_aqi(None, None) is None


def test_dew_point_known_value():
    assert dew_point_c(25.0, 60.0) == pytest.approx(16.7, abs=0.1)
    assert dew_point_c(20.0, 100.0) == pytest.approx(20.0, abs=0.01)
    assert dew_point_c(None, 50.0) is None and dew_point_c(20.0, 0.0) is None


def test_heat_index_nws_table_value():
    assert heat_index_c(32.2, 70.0) == pytest.approx(41.0, abs=1.0)   # 90 F, 70 % -> ~105 F


def test_heat_index_not_applicable_when_cool_or_dry():
    assert heat_index_c(22.0, 50.0) is None
    assert heat_index_c(32.0, 30.0) is None
    assert heat_index_c(None, 50.0) is None


@pytest.mark.parametrize("fn,value,level", [
    (rate_co2, 999, "good"), (rate_co2, 1000, "fair"), (rate_co2, 2000, "poor"), (rate_co2, 5000, "bad"),
    (rate_tvoc, 219, "good"), (rate_tvoc, 660, "poor"), (rate_tvoc, 5000, "bad"),
    (rate_hcho, 20, "good"), (rate_hcho, 81, "poor"), (rate_hcho, 400, "bad"),
    (rate_humidity, 45, "good"), (rate_humidity, 25, "fair"), (rate_humidity, 15, "poor"),
    (rate_humidity, 85, "bad"), (rate_humidity, 30, "good"), (rate_humidity, 60.1, "fair"),
])
def test_ratings(fn, value, level):
    assert fn(value) == level


def test_ratings_none_safe():
    assert rate_co2(None) is None and rate_humidity(None) is None


def test_overall_is_worst_of_with_drivers():
    r = EnvironmentReading(co2=2500, pm25=5.0, humidity_pct=45, tvoc_ppb=100)
    out = overall_air_quality(r)
    assert out == {"level": "poor", "drivers": ["co2"]}


def test_overall_with_no_data():
    assert overall_air_quality(EnvironmentReading()) == {"level": None, "drivers": []}


def test_report_flags_simulated_and_tolerates_missing_fields():
    rep = environment_report(EnvironmentReading(co2=600, temperature_c=22.0, humidity_pct=45.0, simulated=True))
    assert rep["simulated"] is True and rep["reading"]["simulated"] is True
    assert rep["aqi"] is None and rep["heat_index_c"] is None and rep["dew_point_c"] == pytest.approx(9.5, abs=0.1)
    assert rep["overall"]["level"] == "good"
