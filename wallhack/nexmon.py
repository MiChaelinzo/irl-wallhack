"""nexmon_csi decoding: the single implementation of the frame layout and the pcap reader.

Frame layout (seemoo-lab/nexmon_csi, src/csi_extractor.c, little endian, packed):
    uint16 magic 0x1111, int8 rssi, uint8 frame control, 6-byte source MAC, uint16 sequence,
    uint16 csiconf (core = bits 0-2, spatial stream = bits 3-5), uint16 chanspec, uint16 chip,
    then one (int16 real, int16 imag) pair per subcarrier.
For the BCM43455c0 chip in the Raspberry Pi 3B+/4B/5 the CSI is plain int16 I/Q (upstream
utils/matlab/csireader.m only uses the packed-float unpack step for bcm4358 and bcm4366c0).

Status: decoding is VERIFIED on synthetic frames built from this documented layout only.
It has never been run against a real capture: UNVERIFIED on hardware. The null/guard
subcarrier positions assume fftshifted order, as listed in the nexmon_csi FAQ: UNVERIFIED.
"""
import math
import struct
from dataclasses import dataclass, field
from statistics import median
from typing import BinaryIO, Dict, FrozenSet, Iterator, List, Optional, Sequence, Set, Tuple

NEXMON_MAGIC = 0x1111
HEADER = struct.Struct("<HbB6sHHHH")  # 18 bytes
CORE_MASK = 0x7
STREAM_SHIFT = 3
STREAM_MASK = 0x7
BYTES_PER_SUBCARRIER = 4  # int16 real + int16 imag
SUBCARRIER_COUNTS = (64, 128, 256)  # 20, 40, 80 MHz
DEFAULT_PORT = 5500

# Null and guard subcarrier indices (array positions, fftshifted order) per subcarrier count.
NULL_SUBCARRIERS: Dict[int, FrozenSet[int]] = {
    64: frozenset(list(range(0, 4)) + [32] + list(range(61, 64))),
    128: frozenset(list(range(0, 6)) + list(range(63, 66)) + list(range(123, 128))),
    256: frozenset(list(range(0, 6)) + list(range(127, 130)) + list(range(251, 256))),
}

# libpcap stream constants
PCAP_MAGICS_LE = {0xA1B2C3D4: "us", 0xA1B23C4D: "ns"}
PCAP_GLOBAL_HEADER_LEN = 24
PCAP_RECORD_HEADER_LEN = 16
PCAP_LINKTYPE_MASK = 0x0FFFFFFF  # upper bits carry FCS information
LINKTYPE_ETHERNET = 1
MAX_PCAP_RECORD_BYTES = 262144
ETHERNET_HEADER_LEN = 14
ETHERTYPE_IPV4 = 0x0800
IPV4_PROTOCOL_UDP = 17
IPV4_MIN_HEADER_LEN = 20
IPV4_FRAGMENT_MASK = 0x3FFF  # more-fragments flag and fragment offset
UDP_HEADER_LEN = 8

# Diagnostics thresholds
MIN_BREATHING_FRAMES_PER_S = 4.0  # same threshold as processing.MIN_BREATH_SAMPLE_HZ


@dataclass(frozen=True)
class NexmonFrame:
    rssi: int
    src_mac: str
    seq: int
    core: int
    stream: int
    chanspec: int
    chip: int
    csi: Tuple[Tuple[int, int], ...]  # (real, imag) per subcarrier

    @property
    def subcarriers(self) -> int:
        return len(self.csi)

    @property
    def link_id(self) -> str:
        """One id per (transmitter, core, stream) so different links never share a time series."""
        tail = self.src_mac.split(":")[-3:]
        return "nx-%s-c%ds%d" % ("".join(tail), self.core, self.stream)


def parse_nexmon_payload(data: bytes) -> Optional[NexmonFrame]:
    """Decode one nexmon_csi UDP payload, or None if it is not a valid frame."""
    if len(data) < HEADER.size:
        return None
    magic, rssi, _fctl, mac, seq, csiconf, chanspec, chip = HEADER.unpack_from(data)
    if magic != NEXMON_MAGIC:
        return None
    body = data[HEADER.size:]
    count = len(body) // BYTES_PER_SUBCARRIER
    if count not in SUBCARRIER_COUNTS or len(body) != count * BYTES_PER_SUBCARRIER:
        return None
    words = struct.unpack("<%dh" % (count * 2), body)
    return NexmonFrame(
        rssi=rssi,
        src_mac=":".join("%02x" % b for b in mac),
        seq=seq,
        core=csiconf & CORE_MASK,
        stream=(csiconf >> STREAM_SHIFT) & STREAM_MASK,
        chanspec=chanspec,
        chip=chip,
        csi=tuple(zip(words[0::2], words[1::2])),
    )


def frame_amplitude_db(frame: NexmonFrame) -> Optional[float]:
    """20*log10 of the mean |I+jQ| over data subcarriers, or None if that mean is zero."""
    skip = NULL_SUBCARRIERS[frame.subcarriers]
    amps = [math.hypot(i, q) for k, (i, q) in enumerate(frame.csi) if k not in skip]
    mean = sum(amps) / len(amps)
    return 20.0 * math.log10(mean) if mean > 0 else None


# ---- pcap stream reader ---------------------------------------------------------------------
def _read_exact(stream: BinaryIO, n: int) -> bytes:
    """Read n bytes, looping over short reads (pipes). Returns fewer only at end of stream."""
    chunks: List[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _udp_payload(packet: bytes, port: int) -> Optional[bytes]:
    """UDP payload of an Ethernet/IPv4/UDP packet addressed to `port`, else None."""
    if len(packet) < ETHERNET_HEADER_LEN + IPV4_MIN_HEADER_LEN + UDP_HEADER_LEN:
        return None
    if struct.unpack_from(">H", packet, 12)[0] != ETHERTYPE_IPV4:
        return None
    ip = packet[ETHERNET_HEADER_LEN:]
    if ip[0] >> 4 != 4:
        return None
    ihl = (ip[0] & 0x0F) * 4
    if ihl < IPV4_MIN_HEADER_LEN or ip[9] != IPV4_PROTOCOL_UDP:
        return None
    if struct.unpack_from(">H", ip, 6)[0] & IPV4_FRAGMENT_MASK:
        return None
    udp = ip[ihl:]
    if len(udp) < UDP_HEADER_LEN:
        return None
    dst_port, udp_len = struct.unpack_from(">HH", udp, 2)
    if dst_port != port or udp_len < UDP_HEADER_LEN:
        return None
    return udp[UDP_HEADER_LEN:udp_len]


def iter_pcap_udp_payloads(stream: BinaryIO, port: int = DEFAULT_PORT) -> Iterator[bytes]:
    """Yield UDP payloads for `port` from a classic libpcap stream (e.g. `tcpdump -U -w -`).

    Raises ValueError for an unknown magic, a non-Ethernet link type or an absurd record size.
    A stream that ends early (empty, or cut inside a record) simply stops.
    """
    head = _read_exact(stream, PCAP_GLOBAL_HEADER_LEN)
    if len(head) < PCAP_GLOBAL_HEADER_LEN:
        return
    magic_le = struct.unpack_from("<I", head)[0]
    magic_be = struct.unpack_from(">I", head)[0]
    if magic_le in PCAP_MAGICS_LE:
        endian = "<"
    elif magic_be in PCAP_MAGICS_LE:
        endian = ">"
    else:
        raise ValueError("not a libpcap stream (magic bytes %s)" % head[:4].hex())
    linktype = struct.unpack_from(endian + "I", head, 20)[0] & PCAP_LINKTYPE_MASK
    if linktype != LINKTYPE_ETHERNET:
        raise ValueError("unsupported pcap link type %d (only Ethernet, 1, is handled; "
                         "capture on wlan0, not a monitor interface)" % linktype)
    record = struct.Struct(endian + "IIII")
    while True:
        rec = _read_exact(stream, PCAP_RECORD_HEADER_LEN)
        if len(rec) < PCAP_RECORD_HEADER_LEN:
            return
        _sec, _frac, incl_len, _orig_len = record.unpack(rec)
        if incl_len > MAX_PCAP_RECORD_BYTES:
            raise ValueError("pcap record of %d bytes is implausible; stream is corrupt" % incl_len)
        packet = _read_exact(stream, incl_len)
        if len(packet) < incl_len:
            return
        payload = _udp_payload(packet, port)
        if payload is not None:
            yield payload


# ---- diagnostics ----------------------------------------------------------------------------
@dataclass
class FrameStats:
    """Bounded record of what a capture has seen, for --csi-check."""
    frames: int = 0
    per_link: Dict[str, int] = field(default_factory=dict)
    subcarrier_counts: Set[int] = field(default_factory=set)
    rssi: List[int] = field(default_factory=list)

    MAX_RSSI_SAMPLES = 2000

    def record(self, frame: NexmonFrame) -> None:
        self.frames += 1
        self.per_link[frame.link_id] = self.per_link.get(frame.link_id, 0) + 1
        self.subcarrier_counts.add(frame.subcarriers)
        if len(self.rssi) < self.MAX_RSSI_SAMPLES:
            self.rssi.append(frame.rssi)


@dataclass
class CsiCheckSummary:
    frames: int
    duration_s: float
    rate_per_link: Dict[str, float]
    subcarriers: Sequence[int]
    median_rssi: Optional[float]
    ok: bool
    verdict: List[str]

    def render(self) -> str:
        lines = ["frames seen: %d in %.1f s" % (self.frames, self.duration_s)]
        for link, rate in sorted(self.rate_per_link.items()):
            lines.append("  %s: %.1f frames/s" % (link, rate))
        if self.subcarriers:
            lines.append("subcarriers: %s" % ", ".join(str(n) for n in self.subcarriers))
        if self.median_rssi is not None:
            lines.append("median RSSI: %.0f dBm" % self.median_rssi)
        lines.extend(self.verdict)
        return "\n".join(lines)


def summarize(stats: FrameStats, duration_s: float, last_error: str = "") -> CsiCheckSummary:
    """Turn capture statistics into a verdict with next-step hints. Pure and deterministic."""
    span = max(duration_s, 1e-9)
    rates = {link: n / span for link, n in stats.per_link.items()}
    verdict: List[str] = []
    if stats.frames == 0:
        verdict.append("NO FRAMES. Check, in order:")
        verdict.append("  1. sudo scripts/pi_setup.sh status (firmware patched, CSI enabled?)")
        verdict.append("  2. the CSI channel matches your access point, and there is traffic or beacons to measure")
        verdict.append("  3. tcpdump may run as your user (CAP_NET_RAW), or start wallhack with sudo")
        if last_error:
            verdict.append("capture error: %s" % last_error)
    else:
        best = max(rates.values())
        if best < MIN_BREATHING_FRAMES_PER_S:
            verdict.append("Frames arrive, but %.1f/s is below %.0f/s: breathing will be disabled. "
                           "Presence and motion still work. Add traffic or lower the beacon interval."
                           % (best, MIN_BREATHING_FRAMES_PER_S))
        else:
            verdict.append("OK: %.1f frames/s is enough for presence, motion and breathing." % best)
    return CsiCheckSummary(
        frames=stats.frames, duration_s=duration_s, rate_per_link=rates,
        subcarriers=sorted(stats.subcarrier_counts),
        median_rssi=float(median(stats.rssi)) if stats.rssi else None,
        ok=stats.frames > 0, verdict=verdict)
