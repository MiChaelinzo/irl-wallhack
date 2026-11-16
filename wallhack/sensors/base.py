"""Shared pieces for sensor drivers: errors, transport interfaces, frame helpers and CRCs.

Drivers take an injected transport, so parsing and polling are testable without hardware.
"""
import importlib
from typing import Callable, Optional, Tuple

SENSIRION_CRC_POLY = 0x31
SENSIRION_CRC_INIT = 0xFF
SMBUS_CRC_POLY = 0x07
MAX_BUFFER_FRAMES = 4          # UART buffer is trimmed to this many frames of the newest bytes


class SensorError(Exception):
    """A sensor produced no usable data. The message says why."""


class OptionalDependencyError(SensorError):
    """An optional extra (pyserial, smbus2) is not installed."""


def require_module(module: str, extra_hint: str):
    """Import an optional dependency lazily with an explainable failure."""
    try:
        return importlib.import_module(module)
    except ImportError as exc:
        raise OptionalDependencyError(
            f"the '{module}' package is required for this sensor but is not installed. "
            f"Install it with: {extra_hint}") from exc


class UartTransport:
    """Non-blocking byte source. read() returns whatever is available (possibly b'')."""

    def read(self) -> bytes:
        raise NotImplementedError


class I2CTransport:
    """Minimal I2C bus. write_read sends `data`, then reads `length` bytes."""

    def write(self, address: int, data: bytes) -> None:
        raise NotImplementedError

    def read(self, address: int, length: int) -> bytes:
        raise NotImplementedError

    def write_read(self, address: int, data: bytes, length: int) -> bytes:
        raise NotImplementedError


class SensorDriver:
    """poll() returns EnvironmentReading field values, or None when there is no new data yet."""
    name = "sensor"
    interval_s = 1.0
    warming_up = False             # True while the device reports readings that are not valid yet

    def poll(self) -> Optional[dict]:
        raise NotImplementedError


def crc8(data: bytes, poly: int, init: int) -> int:
    crc = init
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def sensirion_crc(data: bytes) -> int:
    return crc8(data, SENSIRION_CRC_POLY, SENSIRION_CRC_INIT)


def take_latest_frame(buffer: bytes, header: bytes, length: int,
                      is_valid: Optional[Callable[[bytes], bool]] = None) -> Tuple[Optional[bytes], bytes]:
    """Return (newest complete valid frame, or None; bytes to keep for next time).

    Header bytes can also occur inside a frame's data, so candidates are tried newest first and
    the first one that passes is_valid (for example a checksum test) wins. If candidates exist but
    none validates, only the possible start of an incomplete frame is kept, which resyncs the stream.
    """
    if len(buffer) < length:
        return None, buffer
    end = len(buffer) - length + len(header)
    start = buffer.rfind(header, 0, end)
    while start >= 0:
        frame = buffer[start:start + length]
        if is_valid is None or is_valid(frame):
            return frame, buffer[start + length:]
        end = start + len(header) - 1
        start = buffer.rfind(header, 0, end) if end > 0 else -1
    if buffer.find(header, 0, len(buffer) - length + len(header)) >= 0:
        return None, buffer[-(length - 1):] if length > 1 else b""
    return None, buffer[-length * MAX_BUFFER_FRAMES:]


class FramedUartDriver(SensorDriver):
    """Base for UART sensors that stream fixed-length frames with a known header."""
    header = b""
    frame_length = 0

    def __init__(self, transport: UartTransport):
        self._transport = transport
        self._buffer = b""

    def parse_frame(self, frame: bytes) -> dict:
        raise NotImplementedError

    def _is_valid(self, frame: bytes) -> bool:
        try:
            self.parse_frame(frame)
        except SensorError:
            return False
        return True

    def poll(self) -> Optional[dict]:
        buffer = self._buffer + self._transport.read()
        frame, self._buffer = take_latest_frame(buffer, self.header, self.frame_length, self._is_valid)
        if frame is not None:
            return self.parse_frame(frame)
        newest = buffer.rfind(self.header, 0, len(buffer) - self.frame_length + len(self.header))
        if len(buffer) >= self.frame_length and newest >= 0:
            self.parse_frame(buffer[newest:newest + self.frame_length])  # raises the explainable error
        return None
