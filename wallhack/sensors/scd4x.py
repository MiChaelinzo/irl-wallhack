"""Sensirion SCD40/SCD41 CO2, temperature and humidity sensor (I2C 0x62).

Commands (16-bit, big-endian) per the Sensirion SCD4x datasheet: start_periodic_measurement 0x21B1,
get_data_ready_status 0xE4B8, read_measurement 0xEC05. Every 16-bit word is followed by a CRC-8
(poly 0x31, init 0xFF). Conversions: T = -45 + 175 * raw / 65535, RH = 100 * raw / 65535.
New data arrives about every 5 s. Status: parsers VERIFIED against hand-built words
in tests; sensor UNVERIFIED (no hardware here).
"""
import time
from typing import Callable, List, Optional

from .base import I2CTransport, SensorDriver, SensorError, sensirion_crc

ADDRESS = 0x62
CMD_START_PERIODIC = 0x21B1
CMD_DATA_READY = 0xE4B8
CMD_READ_MEASUREMENT = 0xEC05
FULL_SCALE = 65535.0
TEMP_OFFSET_C, TEMP_SPAN_C, HUMIDITY_SPAN_PCT = -45.0, 175.0, 100.0
DATA_READY_MASK = 0x07FF       # lowest 11 bits are zero when no new measurement is ready
COMMAND_DELAY_S = 0.001        # datasheet: wait 1 ms between sending a read command and reading
WORD_BYTES = 3                 # 2 data bytes + CRC


def _command(code: int) -> bytes:
    return bytes([code >> 8, code & 0xFF])


def parse_words(data: bytes, count: int) -> List[int]:
    """Check CRCs and return `count` 16-bit words from CRC-protected triplets."""
    if len(data) != count * WORD_BYTES:
        raise SensorError(f"SCD4x reply must be {count * WORD_BYTES} bytes, got {len(data)}")
    words = []
    for i in range(count):
        chunk = data[i * WORD_BYTES:(i + 1) * WORD_BYTES]
        if sensirion_crc(chunk[:2]) != chunk[2]:
            raise SensorError(f"SCD4x CRC error in word {i} (got {chunk[2]:#04x}, "
                              f"computed {sensirion_crc(chunk[:2]):#04x}); check I2C wiring")
        words.append((chunk[0] << 8) | chunk[1])
    return words


def convert_measurement(co2_raw: int, temp_raw: int, rh_raw: int) -> dict:
    return {"co2": float(co2_raw), "temperature_c": TEMP_OFFSET_C + TEMP_SPAN_C * temp_raw / FULL_SCALE,
            "humidity_pct": HUMIDITY_SPAN_PCT * rh_raw / FULL_SCALE}


class Scd4x(SensorDriver):
    name = "scd4x"
    interval_s = 5.0

    def __init__(self, bus: I2CTransport, address: int = ADDRESS,
                 sleep: Callable[[float], None] = time.sleep):
        self._bus, self._address, self._sleep = bus, address, sleep
        self._started = False

    def poll(self) -> Optional[dict]:
        if not self._started:
            self._bus.write(self._address, _command(CMD_START_PERIODIC))
            self._started = True
            return None
        self._bus.write(self._address, _command(CMD_DATA_READY))
        self._sleep(COMMAND_DELAY_S)
        ready = parse_words(self._bus.read(self._address, WORD_BYTES), 1)[0]
        if ready & DATA_READY_MASK == 0:
            return None
        self._bus.write(self._address, _command(CMD_READ_MEASUREMENT))
        self._sleep(COMMAND_DELAY_S)
        co2, temp, rh = parse_words(self._bus.read(self._address, 3 * WORD_BYTES), 3)
        if co2 == 0:
            raise SensorError("SCD4x reported 0 ppm CO2, which means the first measurement is not valid yet")
        return convert_measurement(co2, temp, rh)
