"""Sensor parsers and drivers against hand-built frames and fake transports. No hardware."""
import subprocess
import sys

import pytest

from wallhack.config import Config
from wallhack.sensors import ens160, mlx90614, pms5003, scd4x, ze08_ch2o
from wallhack.sensors.base import (I2CTransport, OptionalDependencyError, SensorError, UartTransport,
                                   crc8, sensirion_crc, take_latest_frame)
from wallhack.sensors.hub import ERROR, OK, STALE, WAITING, EnvironmentHub, build_hub
from wallhack.sensors.transports import SerialTransport, Smbus2Transport


# ---- fakes -------------------------------------------------------------------
class FakeUart(UartTransport):
    def __init__(self, *chunks):
        self.chunks = list(chunks)

    def read(self):
        return self.chunks.pop(0) if self.chunks else b""


class FakeI2C(I2CTransport):
    """Replies to reads from a queue and records what was written."""

    def __init__(self, replies=()):
        self.replies, self.writes = list(replies), []

    def write(self, address, data):
        self.writes.append((address, bytes(data)))

    def read(self, address, length):
        return self.replies.pop(0)

    def write_read(self, address, data, length):
        self.writes.append((address, bytes(data)))
        return self.replies.pop(0)


# ---- frame builders -----------------------------------------------------------
def pms_frame(pm1=3, pm25=12, pm10=20):
    body = bytearray([0x42, 0x4D, 0, 28] + [0] * 26)
    for offset, value in ((10, pm1), (12, pm25), (14, pm10)):
        body[offset], body[offset + 1] = value >> 8, value & 0xFF
    total = sum(body)
    return bytes(body) + bytes([total >> 8, total & 0xFF])


def ze08_frame(ppb=45, full_range=2000, unit=0x04):
    body = bytearray([0xFF, 0x17, unit, 0, ppb >> 8, ppb & 0xFF, full_range >> 8, full_range & 0xFF, 0])
    body[8] = ze08_ch2o.checksum(bytes(body))
    return bytes(body)


def sensirion_word(value):
    data = bytes([value >> 8, value & 0xFF])
    return data + bytes([sensirion_crc(data)])


# ---- CRC and framing ------------------------------------------------------------
def test_sensirion_crc_matches_datasheet_example():
    assert sensirion_crc(bytes([0xBE, 0xEF])) == 0x92


def test_take_latest_frame_resyncs_and_keeps_remainder():
    junk = b"\x01\x02"
    frame, rest = take_latest_frame(junk + pms_frame() + b"\x42", pms5003.HEADER, pms5003.FRAME_LENGTH)
    assert frame == pms_frame() and rest == b"\x42"
    none, rest = take_latest_frame(b"\x00" * 5, pms5003.HEADER, pms5003.FRAME_LENGTH)
    assert none is None and rest == b"\x00" * 5


# ---- PMS5003 --------------------------------------------------------------------
def test_pms_parses_atmospheric_values():
    assert pms5003.parse_frame(pms_frame(3, 12, 20)) == {"pm1": 3.0, "pm25": 12.0, "pm10": 20.0}


def test_pms_rejects_bad_checksum_short_and_bad_header():
    bad = bytearray(pms_frame())
    bad[-1] ^= 0xFF
    with pytest.raises(SensorError, match="checksum mismatch"):
        pms5003.parse_frame(bytes(bad))
    with pytest.raises(SensorError, match="32 bytes"):
        pms5003.parse_frame(pms_frame()[:20])
    with pytest.raises(SensorError, match="0x42 0x4D"):
        pms5003.parse_frame(b"\x00" * 32)
    wrong_len = bytearray(pms_frame())
    wrong_len[3] = 5
    with pytest.raises(SensorError, match="length field"):
        pms5003.parse_frame(bytes(wrong_len))


def test_pms_driver_handles_split_reads_and_returns_newest():
    frame = pms_frame(pm25=40)
    driver = pms5003.Pms5003(FakeUart(frame[:10], frame[10:] + pms_frame(pm25=55)))
    assert driver.poll() is None                   # incomplete frame
    assert driver.poll()["pm25"] == 55.0           # newest of the two complete frames


def test_pms_driver_raises_on_corrupt_frame():
    bad = bytearray(pms_frame())
    bad[-2] ^= 0x01
    with pytest.raises(SensorError):
        pms5003.Pms5003(FakeUart(bytes(bad))).poll()


# ---- ZE08-CH2O --------------------------------------------------------------------
def test_ze08_parses_ppb():
    assert ze08_ch2o.parse_frame(ze08_frame(ppb=300)) == {"hcho_ppb": 300.0}


def test_ze08_rejects_corrupt_frames():
    bad = bytearray(ze08_frame())
    bad[8] ^= 0xFF
    with pytest.raises(SensorError, match="checksum"):
        ze08_ch2o.parse_frame(bytes(bad))
    with pytest.raises(SensorError, match="9 bytes"):
        ze08_ch2o.parse_frame(ze08_frame()[:5])
    with pytest.raises(SensorError, match="0xFF 0x17"):
        ze08_ch2o.parse_frame(b"\x00" * 9)
    with pytest.raises(SensorError, match="only ppb"):
        ze08_ch2o.parse_frame(ze08_frame(unit=0x02))
    with pytest.raises(SensorError, match="full range"):
        ze08_ch2o.parse_frame(ze08_frame(ppb=3000, full_range=2000))


def test_ze08_driver_reads_through_transport():
    assert ze08_ch2o.Ze08Ch2o(FakeUart(ze08_frame(ppb=77))).poll() == {"hcho_ppb": 77.0}


# ---- SCD4x --------------------------------------------------------------------------
def test_scd4x_example_conversion():
    data = bytes.fromhex("01f4" "33" "6667" "a2" "5eb9" "3c")
    co2, temp, rh = scd4x.parse_words(data, 3)
    out = scd4x.convert_measurement(co2, temp, rh)
    assert out["co2"] == 500.0
    assert out["temperature_c"] == pytest.approx(25.0, abs=0.01)
    assert out["humidity_pct"] == pytest.approx(37.0, abs=0.01)


def test_scd4x_rejects_bad_crc_and_short_reply():
    with pytest.raises(SensorError, match="CRC"):
        scd4x.parse_words(bytes.fromhex("01f434"), 1)
    with pytest.raises(SensorError, match="bytes"):
        scd4x.parse_words(b"\x01\xf4", 1)


def test_scd4x_driver_sequence():
    reading = sensirion_word(500) + sensirion_word(0x6667) + sensirion_word(0x5EB9)
    bus = FakeI2C([sensirion_word(0x0000), sensirion_word(0x8006), reading])
    driver = scd4x.Scd4x(bus, sleep=lambda s: None)
    assert driver.poll() is None                      # starts periodic measurement
    assert bus.writes[0] == (0x62, bytes([0x21, 0xB1]))
    assert driver.poll() is None                      # data-ready status says not ready
    out = driver.poll()
    assert out["co2"] == 500.0
    assert bus.writes[-1] == (0x62, bytes([0xEC, 0x05]))


def test_scd4x_zero_co2_is_an_error():
    reading = sensirion_word(0) + sensirion_word(0x6667) + sensirion_word(0x5EB9)
    driver = scd4x.Scd4x(FakeI2C([sensirion_word(0x8006), reading]), sleep=lambda s: None)
    driver.poll()
    with pytest.raises(SensorError, match="not valid"):
        driver.poll()


# ---- ENS160 -------------------------------------------------------------------------
def test_ens160_reads_tvoc_after_enabling_standard_mode():
    bus = FakeI2C([bytes([0x02]), bytes([0xC8, 0x00])])    # status NEWDAT, validity normal; TVOC 200 ppb
    driver = ens160.Ens160(bus)
    assert driver.poll() is None
    assert bus.writes[0] == (0x52, bytes([0x10, 0x02]))
    assert driver.poll() == {"tvoc_ppb": 200.0}
    assert bus.writes[-1] == (0x52, bytes([0x22]))


def test_ens160_little_endian_and_states():
    bus = FakeI2C([bytes([0x02]), bytes([0x34, 0x12])])
    driver = ens160.Ens160(bus)
    driver.poll()
    assert driver.poll() == {"tvoc_ppb": float(0x1234)}
    startup = ens160.Ens160(FakeI2C([bytes([0x02 | (2 << 2)])]))
    startup.poll()
    assert startup.poll() is None                          # initial start-up: not trusted yet
    nodata = ens160.Ens160(FakeI2C([bytes([0x00])]))
    nodata.poll()
    assert nodata.poll() is None
    invalid = ens160.Ens160(FakeI2C([bytes([3 << 2])]))
    invalid.poll()
    with pytest.raises(SensorError, match="invalid"):
        invalid.poll()


# ---- MLX90614 ------------------------------------------------------------------------
def mlx_reply(raw, address=0x5A, corrupt=False):
    low, high = raw & 0xFF, raw >> 8
    pec = crc8(bytes([address << 1, 0x07, (address << 1) | 1, low, high]), 0x07, 0)
    return bytes([low, high, pec ^ (1 if corrupt else 0)])


def test_mlx_converts_raw_to_celsius():
    raw = round((36.6 + 273.15) / 0.02)
    assert mlx90614.parse_object_temperature(0x5A, mlx_reply(raw)) == pytest.approx(36.6, abs=0.02)


def test_mlx_rejects_bad_pec_error_bit_range_and_length():
    with pytest.raises(SensorError, match="PEC"):
        mlx90614.parse_object_temperature(0x5A, mlx_reply(15000, corrupt=True))
    with pytest.raises(SensorError, match="error"):
        mlx90614.parse_object_temperature(0x5A, mlx_reply(0x8001))
    with pytest.raises(SensorError, match="outside"):
        mlx90614.parse_object_temperature(0x5A, mlx_reply(100))
    with pytest.raises(SensorError, match="3 bytes"):
        mlx90614.parse_object_temperature(0x5A, b"\x00")


def test_mlx_driver_reads_register_7():
    bus = FakeI2C([mlx_reply(15488)])
    out = mlx90614.Mlx90614(bus).poll()
    assert out["surface_temp_c"] == pytest.approx(36.61, abs=0.02)
    assert bus.writes == [(0x5A, bytes([0x07]))]


# ---- hub ----------------------------------------------------------------------------
class ScriptedDriver:
    interval_s = 1.0

    def __init__(self, name, *outcomes):
        self.name, self.outcomes = name, list(outcomes)

    def poll(self):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class Clock:
    now = 100.0

    def __call__(self):
        return self.now


def test_hub_merges_sensors_and_tracks_status():
    clock = Clock()
    a = ScriptedDriver("pms5003", {"pm25": 10.0, "pm10": 15.0}, {"pm25": 12.0})
    b = ScriptedDriver("scd4x", {"co2": 700.0, "temperature_c": 21.0})
    hub = EnvironmentHub([a, b], clock=clock)
    assert hub.status()["pms5003"]["state"] == WAITING
    hub.poll_once()
    reading = hub.reading()
    assert (reading.pm25, reading.co2, reading.temperature_c) == (10.0, 700.0, 21.0)
    assert reading.pm1 is None and reading.simulated is False
    assert hub.status()["scd4x"]["state"] == OK


def test_hub_respects_driver_interval():
    clock = Clock()
    d = ScriptedDriver("pms5003", {"pm25": 1.0}, {"pm25": 2.0})
    hub = EnvironmentHub([d], clock=clock)
    hub.poll_once()
    clock.now += 0.4
    hub.poll_once()
    assert hub.reading().pm25 == 1.0 and len(d.outcomes) == 1
    clock.now += 0.7
    hub.poll_once()
    assert hub.reading().pm25 == 2.0


def test_hub_marks_stale_and_drops_stale_values():
    clock = Clock()
    hub = EnvironmentHub([ScriptedDriver("pms5003", {"pm25": 9.0}, None, None, None, None)], clock=clock)
    hub.poll_once()
    for _ in range(4):
        clock.now += 1.0
        hub.poll_once()
    assert hub.status()["pms5003"]["state"] == STALE
    assert hub.reading().pm25 is None


def test_hub_surfaces_errors_and_recovers(caplog):
    clock = Clock()
    d = ScriptedDriver("scd4x", {"co2": 800.0}, SensorError("CRC error"), {"co2": 650.0})
    hub = EnvironmentHub([d], clock=clock)
    hub.poll_once()
    clock.now += 1.1
    with caplog.at_level("WARNING", logger="wallhack"):
        hub.poll_once()
    st = hub.status()["scd4x"]
    assert st["state"] == ERROR and "CRC error" in st["message"]
    assert "CRC error" in caplog.text
    assert hub.reading().co2 is None
    clock.now += 1.1
    hub.poll_once()
    assert hub.status()["scd4x"]["state"] == OK and hub.reading().co2 == 650.0


def test_hub_rejects_driver_returning_unknown_fields():
    hub = EnvironmentHub([ScriptedDriver("x", {"bogus": 1.0})], clock=Clock())
    with pytest.raises(ValueError, match="unknown fields"):
        hub.poll_once()


def test_oserror_from_transport_is_reported_not_raised():
    hub = EnvironmentHub([ScriptedDriver("ens160", OSError("no device"))], clock=Clock())
    hub.poll_once()
    assert "no device" in hub.status()["ens160"]["message"]


# ---- build_hub and optional dependencies -----------------------------------------------
def test_build_hub_reports_missing_dependency_per_sensor():
    def no_serial(port):
        raise OptionalDependencyError("pyserial missing")

    cfg = Config(sensors="pms5003,ze08", background=False)
    hub = build_hub(cfg, serial_factory=no_serial)
    st = hub.status()
    assert st["pms5003"]["state"] == ERROR and "pyserial missing" in st["pms5003"]["message"]
    assert st["ze08"]["state"] == ERROR


def test_build_hub_shares_one_i2c_bus_and_passes_ports():
    ports, buses = [], []

    def serial_factory(port):
        ports.append(port)
        return FakeUart()

    def i2c_factory(bus):
        buses.append(bus)
        return FakeI2C()

    cfg = Config(sensors="pms5003,scd4x,ens160,mlx90614,ze08", serial_pms="/dev/a", serial_hcho="/dev/b",
                 i2c_bus=3, background=False)
    hub = build_hub(cfg, serial_factory, i2c_factory)
    assert ports == ["/dev/a", "/dev/b"] and buses == [3]
    assert set(hub.status()) == {"pms5003", "scd4x", "ens160", "mlx90614", "ze08"}


def test_real_transports_explain_missing_optional_packages(monkeypatch):
    monkeypatch.setitem(sys.modules, "serial", None)
    monkeypatch.setitem(sys.modules, "smbus2", None)
    with pytest.raises(OptionalDependencyError, match="pyserial"):
        SerialTransport("/dev/null")
    with pytest.raises(OptionalDependencyError, match="smbus2"):
        Smbus2Transport(1)


def test_importing_the_app_never_loads_optional_packages():
    code = ("import sys, wallhack.runtime, wallhack.sensors.hub; "
            "bad = [m for m in ('serial', 'smbus2') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    assert subprocess.run([sys.executable, "-c", code]).returncode == 0


# ---- config ----------------------------------------------------------------------------
def test_config_sensor_validation():
    assert Config(sensors=" PMS5003, scd4x,pms5003 ").sensor_names() == ("pms5003", "scd4x")
    Config(sensors="pms5003,ze08").validate()
    with pytest.raises(ValueError, match="unknown sensors"):
        Config(sensors="pms5003,laser").validate()
    with pytest.raises(ValueError, match="i2c_bus"):
        Config(i2c_bus=-1).validate()
