"""Pure environment maths: readings in, AQI, comfort values and air-quality ratings out.

No I/O and no clock. Ratings are general guidance bands, not medical or regulatory advice.
"""
import math
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Tuple

# ---- US EPA Air Quality Index ------------------------------------------------
# Source: US EPA, "Technical Assistance Document for the Reporting of Daily Air Quality"
# (AQI breakpoints as revised in 2024 for PM2.5). Rows: (conc_low, conc_high, aqi_low, aqi_high).
PM25_BREAKPOINTS: Tuple[Tuple[float, float, int, int], ...] = (
    (0.0, 9.0, 0, 50), (9.1, 35.4, 51, 100), (35.5, 55.4, 101, 150),
    (55.5, 125.4, 151, 200), (125.5, 225.4, 201, 300), (225.5, 325.4, 301, 500),
)
PM10_BREAKPOINTS: Tuple[Tuple[float, float, int, int], ...] = (
    (0, 54, 0, 50), (55, 154, 51, 100), (155, 254, 101, 150), (255, 354, 151, 200),
    (355, 424, 201, 300), (425, 504, 301, 400), (505, 604, 401, 500),
)
AQI_MAX = 500
PM25_TRUNCATE_DECIMALS = 1     # EPA truncates PM2.5 to 0.1 ug/m3 and PM10 to whole ug/m3
AQI_CATEGORIES = ((50, "Good"), (100, "Moderate"), (150, "Unhealthy for Sensitive Groups"),
                  (200, "Unhealthy"), (300, "Very Unhealthy"), (AQI_MAX, "Hazardous"))

# ---- comfort formulas ---------------------------------------------------------
MAGNUS_A, MAGNUS_B = 17.62, 243.12   # Sonntag 1990 constants, valid -45..60 C
HEAT_INDEX_MIN_F = 80.0              # NWS: Rothfusz regression applies from 80 F ...
HEAT_INDEX_MIN_RH = 40.0             # ... and 40 % relative humidity
ROTHFUSZ = (-42.379, 2.04901523, 10.14333127, -0.22475541, -0.00683783,
            -0.05481717, 0.00122874, 0.00085282, -0.00000199)

# ---- rating bands --------------------------------------------------------------
LEVELS = ("good", "fair", "poor", "bad")
# Each tuple holds the exclusive upper limits of good, fair, poor; anything above is bad.
CO2_LIMITS_PPM = (1000.0, 2000.0, 5000.0)   # Umweltbundesamt 2008 (1000/2000 ppm); OSHA 8 h limit 5000 ppm
TVOC_LIMITS_PPB = (220.0, 660.0, 2200.0)    # ScioSense ENS160 datasheet UBA levels 2/3/4 boundaries
HCHO_LIMITS_PPB = (40.0, 81.0, 160.0)       # WHO 30 min guideline 100 ug/m3 = ~81 ppb at 25 C
AQI_LIMITS = (50, 100, 150)                 # EPA: Good, Moderate, Unhealthy for Sensitive Groups
# Humidity is rated by distance from comfort: inclusive (low, high) ranges for good, fair, poor.
HUMIDITY_RANGES_PCT = ((30.0, 60.0), (20.0, 70.0), (10.0, 80.0))  # ASHRAE 55 style comfort band


@dataclass
class EnvironmentReading:
    """One merged snapshot. Every sensor field is None when no sensor supplies it."""
    pm1: Optional[float] = None            # ug/m3
    pm25: Optional[float] = None           # ug/m3
    pm10: Optional[float] = None           # ug/m3
    co2: Optional[float] = None            # ppm
    temperature_c: Optional[float] = None  # air temperature
    humidity_pct: Optional[float] = None   # relative humidity
    tvoc_ppb: Optional[float] = None
    hcho_ppb: Optional[float] = None       # formaldehyde, parts per billion
    surface_temp_c: Optional[float] = None  # infrared object temperature (not core body temperature)
    simulated: bool = False
    t: Optional[float] = None              # seconds on the runtime clock

    def as_dict(self) -> dict:
        return asdict(self)


def _truncate(value: float, decimals: int) -> float:
    factor = 10 ** decimals
    return math.floor(value * factor + 1e-9) / factor


def _aqi_from_table(conc: float, table) -> int:
    for lo, hi, aqi_lo, aqi_hi in table:
        if conc <= hi:
            if conc < lo:  # gap between rows after truncation cannot occur; stay safe
                conc = lo
            return round((aqi_hi - aqi_lo) / (hi - lo) * (conc - lo) + aqi_lo)
    return AQI_MAX


def aqi_category(aqi: int) -> str:
    for upper, name in AQI_CATEGORIES:
        if aqi <= upper:
            return name
    return AQI_CATEGORIES[-1][1]


def us_epa_aqi(pm25: Optional[float], pm10: Optional[float]) -> Optional[dict]:
    """Overall US EPA AQI: the higher of the PM2.5 and PM10 sub-indices, or None with no PM data."""
    subs: Dict[str, int] = {}
    if pm25 is not None:
        subs["pm25"] = _aqi_from_table(_truncate(max(pm25, 0.0), PM25_TRUNCATE_DECIMALS), PM25_BREAKPOINTS)
    if pm10 is not None:
        subs["pm10"] = _aqi_from_table(_truncate(max(pm10, 0.0), 0), PM10_BREAKPOINTS)
    if not subs:
        return None
    pollutant = max(subs, key=lambda k: subs[k])
    return {"aqi": subs[pollutant], "pollutant": pollutant, "category": aqi_category(subs[pollutant])}


def dew_point_c(temperature_c: Optional[float], humidity_pct: Optional[float]) -> Optional[float]:
    """Dew point by the Magnus formula (Sonntag constants)."""
    if temperature_c is None or humidity_pct is None or humidity_pct <= 0:
        return None
    gamma = math.log(humidity_pct / 100.0) + MAGNUS_A * temperature_c / (MAGNUS_B + temperature_c)
    return MAGNUS_B * gamma / (MAGNUS_A - gamma)


def heat_index_c(temperature_c: Optional[float], humidity_pct: Optional[float]) -> Optional[float]:
    """NWS Rothfusz heat index in C, or None outside its range (below 80 F or below 40 % RH)."""
    if temperature_c is None or humidity_pct is None:
        return None
    t = temperature_c * 9.0 / 5.0 + 32.0
    rh = humidity_pct
    if t < HEAT_INDEX_MIN_F or rh < HEAT_INDEX_MIN_RH:
        return None
    c = ROTHFUSZ
    hi = (c[0] + c[1] * t + c[2] * rh + c[3] * t * rh + c[4] * t * t + c[5] * rh * rh
          + c[6] * t * t * rh + c[7] * t * rh * rh + c[8] * t * t * rh * rh)
    return (hi - 32.0) * 5.0 / 9.0


def _rate_by_limits(value: Optional[float], limits) -> Optional[str]:
    if value is None:
        return None
    for level, limit in zip(LEVELS, limits):
        if value < limit:
            return level
    return LEVELS[-1]


def rate_co2(ppm: Optional[float]) -> Optional[str]:
    return _rate_by_limits(ppm, CO2_LIMITS_PPM)


def rate_tvoc(ppb: Optional[float]) -> Optional[str]:
    return _rate_by_limits(ppb, TVOC_LIMITS_PPB)


def rate_hcho(ppb: Optional[float]) -> Optional[str]:
    return _rate_by_limits(ppb, HCHO_LIMITS_PPB)


def rate_aqi(aqi: Optional[int]) -> Optional[str]:
    if aqi is None:
        return None
    for level, upper in zip(LEVELS, AQI_LIMITS):
        if aqi <= upper:
            return level
    return LEVELS[-1]


def rate_humidity(pct: Optional[float]) -> Optional[str]:
    if pct is None:
        return None
    for level, (low, high) in zip(LEVELS, HUMIDITY_RANGES_PCT):
        if low <= pct <= high:
            return level
    return LEVELS[-1]


# ---- Healthy / Warning / Danger status per metric -------------------------------------------------
STATUS_LEVELS = ("Healthy", "Warning", "Danger")
PM25_STATUS_LIMITS = (9.0, 35.4)       # EPA Good / Moderate upper bounds (ug/m3)
PM10_STATUS_LIMITS = (54.0, 154.0)     # EPA Good / Moderate upper bounds (ug/m3)
TEMPERATURE_RANGES_C = ((18.0, 26.0), (16.0, 30.0))   # general comfort guidance, not medical advice
_LEVEL_TO_STATUS = {"good": "Healthy", "fair": "Warning", "poor": "Danger", "bad": "Danger"}


def _status_by_limits(value: Optional[float], limits) -> Optional[str]:
    if value is None:
        return None
    for status, limit in zip(STATUS_LEVELS, limits):
        if value <= limit:
            return status
    return STATUS_LEVELS[-1]


def rate_temperature(temperature_c: Optional[float]) -> Optional[str]:
    if temperature_c is None:
        return None
    for status, (low, high) in zip(STATUS_LEVELS, TEMPERATURE_RANGES_C):
        if low <= temperature_c <= high:
            return status
    return STATUS_LEVELS[-1]


def metric_statuses(reading: EnvironmentReading) -> Dict[str, Optional[dict]]:
    """Healthy/Warning/Danger per metric: CO2, humidity, temperature, TVOC, PM2.5, PM10 and AQI.
    A metric without data is None. 'poor' and 'bad' ratings both map to Danger."""
    aqi = us_epa_aqi(reading.pm25, reading.pm10)
    rows = {
        "co2": (reading.co2, "ppm", _map_level(rate_co2(reading.co2))),
        "humidity": (reading.humidity_pct, "%", _map_level(rate_humidity(reading.humidity_pct))),
        "temperature": (reading.temperature_c, "C", rate_temperature(reading.temperature_c)),
        "tvoc": (reading.tvoc_ppb, "ppb", _map_level(rate_tvoc(reading.tvoc_ppb))),
        "pm25": (reading.pm25, "ug/m3", _status_by_limits(reading.pm25, PM25_STATUS_LIMITS)),
        "pm10": (reading.pm10, "ug/m3", _status_by_limits(reading.pm10, PM10_STATUS_LIMITS)),
        "aqi": (aqi["aqi"] if aqi else None, "", _map_level(rate_aqi(aqi["aqi"]) if aqi else None)),
    }
    return {k: None if v[0] is None else {"value": v[0], "unit": v[1], "status": v[2]} for k, v in rows.items()}


def _map_level(level: Optional[str]) -> Optional[str]:
    return None if level is None else _LEVEL_TO_STATUS[level]


def ratings(reading: EnvironmentReading) -> Dict[str, Optional[str]]:
    aqi = us_epa_aqi(reading.pm25, reading.pm10)
    return {"particulates": rate_aqi(aqi["aqi"]) if aqi else None,
            "co2": rate_co2(reading.co2), "tvoc": rate_tvoc(reading.tvoc_ppb),
            "hcho": rate_hcho(reading.hcho_ppb), "humidity": rate_humidity(reading.humidity_pct)}


def overall_air_quality(reading: EnvironmentReading) -> dict:
    """Worst-of rating over every metric that has data. drivers lists the metrics at that level."""
    rated = {k: v for k, v in ratings(reading).items() if v is not None}
    if not rated:
        return {"level": None, "drivers": []}
    worst = max(rated.values(), key=LEVELS.index)
    drivers: List[str] = [k for k, v in rated.items() if v == worst]
    return {"level": worst, "drivers": drivers}


def environment_report(reading: EnvironmentReading) -> dict:
    """Everything the dashboard shows for one reading."""
    dew = dew_point_c(reading.temperature_c, reading.humidity_pct)
    heat = heat_index_c(reading.temperature_c, reading.humidity_pct)
    return {"reading": reading.as_dict(), "aqi": us_epa_aqi(reading.pm25, reading.pm10),
            "dew_point_c": None if dew is None else round(dew, 1),
            "heat_index_c": None if heat is None else round(heat, 1),
            "ratings": ratings(reading), "status": metric_statuses(reading), "overall": overall_air_quality(reading),
            "simulated": reading.simulated}
