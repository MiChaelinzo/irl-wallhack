"""Plantower PMS5003 particulate sensor (UART, 9600 baud, active mode).

Frame (32 bytes, big-endian words), per the Plantower PMS5003 datasheet:
  0-1 header 0x42 0x4D | 2-3 frame length (28) | 4-9 PM1.0/2.5/10 factory (CF=1)
  10-15 PM1.0/2.5/10 atmospheric (ug/m3, used here) | 16-27 particle counts | 28-29 reserved
  30-31 checksum = sum of bytes 0-29.
Status: parser VERIFIED against hand-built frames; sensor itself UNVERIFIED (no hardware here).
"""
from .base import FramedUartDriver, SensorError

HEADER = b"\x42\x4d"
FRAME_LENGTH = 32
PAYLOAD_LENGTH = 28            # value of the length word: bytes after it, including the checksum
CHECKSUM_OFFSET = 30
PM1_OFFSET, PM25_OFFSET, PM10_OFFSET = 10, 12, 14   # atmospheric-environment words


def _word(frame: bytes, offset: int) -> int:
    return (frame[offset] << 8) | frame[offset + 1]


def parse_frame(frame: bytes) -> dict:
    if len(frame) != FRAME_LENGTH:
        raise SensorError(f"PMS5003 frame must be {FRAME_LENGTH} bytes, got {len(frame)}")
    if frame[:2] != HEADER:
        raise SensorError("PMS5003 frame does not start with 0x42 0x4D")
    if _word(frame, 2) != PAYLOAD_LENGTH:
        raise SensorError(f"PMS5003 length field is {_word(frame, 2)}, expected {PAYLOAD_LENGTH}")
    expected = sum(frame[:CHECKSUM_OFFSET]) & 0xFFFF
    if _word(frame, CHECKSUM_OFFSET) != expected:
        raise SensorError(f"PMS5003 checksum mismatch (frame {_word(frame, CHECKSUM_OFFSET):#06x}, "
                          f"computed {expected:#06x}); check wiring and baud rate")
    return {"pm1": float(_word(frame, PM1_OFFSET)), "pm25": float(_word(frame, PM25_OFFSET)),
            "pm10": float(_word(frame, PM10_OFFSET))}


class Pms5003(FramedUartDriver):
    name = "pms5003"
    interval_s = 1.0
    header = HEADER
    frame_length = FRAME_LENGTH

    def parse_frame(self, frame: bytes) -> dict:
        return parse_frame(frame)
