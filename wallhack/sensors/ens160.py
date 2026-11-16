"""ScioSense ENS160 air-quality sensor: TVOC in ppb (I2C).

Registers per the ENS160 datasheet: OPMODE 0x10 (0x02 = standard), DEVICE_STATUS 0x20
(bits 3:2 validity: 0 normal, 1 warm-up, 2 initial start-up, 3 invalid; bit 1 NEWDAT),
DATA_AQI 0x21, DATA_TVOC 0x22 (uint16 little-endian, ppb), DATA_ECO2 0x24. Only TVOC is used:
CO2 comes from the SCD4x, whose reading is a measurement, not an estimate.
Default address 0x52 (ADDR pin low); pass 0x53 when the ADDR pin is high.
Status: register handling VERIFIED against a fake bus; sensor UNVERIFIED (no hardware here).
"""
from typing import Optional

from .base import I2CTransport, SensorDriver, SensorError

ADDRESS = 0x52
REG_OPMODE = 0x10
REG_STATUS = 0x20
REG_TVOC = 0x22
OPMODE_STANDARD = 0x02
STATUS_NEWDAT = 0x02
VALIDITY_SHIFT, VALIDITY_MASK = 2, 0x03
VALIDITY_NORMAL, VALIDITY_WARMUP, VALIDITY_STARTUP, VALIDITY_INVALID = 0, 1, 2, 3


class Ens160(SensorDriver):
    name = "ens160"
    interval_s = 1.0

    def __init__(self, bus: I2CTransport, address: int = ADDRESS):
        self._bus, self._address = bus, address
        self._started = False
        self.warming_up = False

    def poll(self) -> Optional[dict]:
        if not self._started:
            self._bus.write(self._address, bytes([REG_OPMODE, OPMODE_STANDARD]))
            self._started = True
            return None
        status = self._bus.write_read(self._address, bytes([REG_STATUS]), 1)[0]
        validity = (status >> VALIDITY_SHIFT) & VALIDITY_MASK
        if validity == VALIDITY_INVALID:
            raise SensorError("ENS160 reports invalid output (status validity 3); check power and wiring")
        # Warm-up (about 3 minutes) and initial start-up (up to an hour) readings are not valid
        # per the datasheet: hold them back and let the hub report the sensor as warming up.
        self.warming_up = validity in (VALIDITY_WARMUP, VALIDITY_STARTUP)
        if self.warming_up or not status & STATUS_NEWDAT:
            return None
        raw = self._bus.write_read(self._address, bytes([REG_TVOC]), 2)
        if len(raw) != 2:
            raise SensorError(f"ENS160 TVOC read returned {len(raw)} bytes, expected 2")
        return {"tvoc_ppb": float(raw[0] | (raw[1] << 8))}
