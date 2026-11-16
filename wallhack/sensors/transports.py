"""Real I/O for sensors. pyserial and smbus2 are optional extras, imported only when used.

Status: UNVERIFIED on hardware. The drivers above these classes are tested with fake transports.
"""
from .base import I2CTransport, UartTransport, require_module

SENSORS_EXTRA_HINT = "pip install 'irl-wallhack[sensors]'  (or: pip install pyserial smbus2)"
SENSOR_BAUD = 9600             # PMS5003 and ZE08-CH2O both default to 9600 baud


class SerialTransport(UartTransport):
    def __init__(self, port: str, baudrate: int = SENSOR_BAUD):
        serial = require_module("serial", SENSORS_EXTRA_HINT)
        self._port = serial.Serial(port, baudrate, timeout=0)  # timeout 0 = non-blocking reads

    def read(self) -> bytes:
        waiting = self._port.in_waiting
        return self._port.read(waiting) if waiting else b""


class Smbus2Transport(I2CTransport):
    def __init__(self, bus_number: int):
        self._smbus2 = require_module("smbus2", SENSORS_EXTRA_HINT)
        self._bus = self._smbus2.SMBus(bus_number)

    def write(self, address: int, data: bytes) -> None:
        self._bus.i2c_rdwr(self._smbus2.i2c_msg.write(address, list(data)))

    def read(self, address: int, length: int) -> bytes:
        msg = self._smbus2.i2c_msg.read(address, length)
        self._bus.i2c_rdwr(msg)
        return bytes(msg)

    def write_read(self, address: int, data: bytes, length: int) -> bytes:
        out, back = self._smbus2.i2c_msg.write(address, list(data)), self._smbus2.i2c_msg.read(address, length)
        self._bus.i2c_rdwr(out, back)
        return bytes(back)
