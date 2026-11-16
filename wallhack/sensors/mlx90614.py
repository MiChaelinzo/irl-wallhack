"""Melexis MLX90614 infrared thermometer: object (surface) temperature over SMBus 0x5A.

RAM register 0x07 = Tobj1, 16-bit little-endian, followed by a PEC byte (CRC-8, poly 0x07 over
the address-write byte, command, address-read byte and the two data bytes). Raw value bit 15 set
means error. T[C] = raw * 0.02 - 273.15 (MLX90614 datasheet). The sensor measures surface
temperature of whatever it points at. It is not a core body temperature reading.
Status: conversion and PEC VERIFIED in tests against hand-built words; sensor UNVERIFIED.
"""
from typing import Optional

from .base import I2CTransport, SMBUS_CRC_POLY, SensorDriver, SensorError, crc8

ADDRESS = 0x5A
REG_TOBJ1 = 0x07
RAW_ERROR_BIT = 0x8000
KELVIN_PER_COUNT = 0.02
ZERO_CELSIUS_IN_KELVIN = 273.15
SANITY_RANGE_C = (-70.0, 380.0)   # datasheet object temperature range
REPLY_BYTES = 3                   # low, high, PEC


def parse_object_temperature(address: int, reply: bytes) -> float:
    if len(reply) != REPLY_BYTES:
        raise SensorError(f"MLX90614 reply must be {REPLY_BYTES} bytes, got {len(reply)}")
    low, high, pec = reply
    expected = crc8(bytes([address << 1, REG_TOBJ1, (address << 1) | 1, low, high]), SMBUS_CRC_POLY, 0)
    if pec != expected:
        raise SensorError(f"MLX90614 PEC mismatch (got {pec:#04x}, computed {expected:#04x}); check I2C wiring")
    raw = (high << 8) | low
    if raw & RAW_ERROR_BIT:
        raise SensorError("MLX90614 flagged the reading as an error (raw bit 15 set)")
    celsius = raw * KELVIN_PER_COUNT - ZERO_CELSIUS_IN_KELVIN
    if not SANITY_RANGE_C[0] <= celsius <= SANITY_RANGE_C[1]:
        raise SensorError(f"MLX90614 temperature {celsius:.1f} C is outside {SANITY_RANGE_C}")
    return celsius


class Mlx90614(SensorDriver):
    name = "mlx90614"
    interval_s = 1.0

    def __init__(self, bus: I2CTransport, address: int = ADDRESS):
        self._bus, self._address = bus, address

    def poll(self) -> Optional[dict]:
        reply = self._bus.write_read(self._address, bytes([REG_TOBJ1]), REPLY_BYTES)
        return {"surface_temp_c": parse_object_temperature(self._address, reply)}
