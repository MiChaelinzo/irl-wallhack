"""Winsen ZE08-CH2O formaldehyde module (UART, 9600 baud, active upload).

Frame (9 bytes) as I understand the Winsen ZE08-CH2O datasheet:
  0 start 0xFF | 1 gas id 0x17 (CH2O) | 2 unit 0x04 (ppb) | 3 decimals
  4-5 concentration (big-endian, ppb) | 6-7 full range (big-endian) | 8 checksum
  checksum = ((~(sum of bytes 1-7)) + 1) & 0xFF.
Status: parser VERIFIED against hand-built frames; the byte layout was NOT checked against the
datasheet PDF or a module, so treat it as PARTIALLY VERIFIED. Hardware UNVERIFIED.
"""
from .base import FramedUartDriver, SensorError

HEADER = b"\xff\x17"
FRAME_LENGTH = 9
UNIT_PPB = 0x04
UNIT_OFFSET, CONC_OFFSET, RANGE_OFFSET, CHECKSUM_OFFSET = 2, 4, 6, 8


def checksum(frame: bytes) -> int:
    return ((~sum(frame[1:CHECKSUM_OFFSET])) + 1) & 0xFF


def parse_frame(frame: bytes) -> dict:
    if len(frame) != FRAME_LENGTH:
        raise SensorError(f"ZE08-CH2O frame must be {FRAME_LENGTH} bytes, got {len(frame)}")
    if frame[:2] != HEADER:
        raise SensorError("ZE08-CH2O frame does not start with 0xFF 0x17")
    if frame[CHECKSUM_OFFSET] != checksum(frame):
        raise SensorError(f"ZE08-CH2O checksum mismatch (frame {frame[CHECKSUM_OFFSET]:#04x}, "
                          f"computed {checksum(frame):#04x}); check wiring and baud rate")
    if frame[UNIT_OFFSET] != UNIT_PPB:
        raise SensorError(f"ZE08-CH2O reports unit code {frame[UNIT_OFFSET]:#04x}; only ppb (0x04) is supported")
    ppb = (frame[CONC_OFFSET] << 8) | frame[CONC_OFFSET + 1]
    full_range = (frame[RANGE_OFFSET] << 8) | frame[RANGE_OFFSET + 1]
    if ppb > full_range:
        raise SensorError(f"ZE08-CH2O concentration {ppb} ppb exceeds its full range {full_range} ppb")
    return {"hcho_ppb": float(ppb)}


class Ze08Ch2o(FramedUartDriver):
    name = "ze08"
    interval_s = 1.0
    header = HEADER
    frame_length = FRAME_LENGTH

    def parse_frame(self, frame: bytes) -> dict:
        return parse_frame(frame)
