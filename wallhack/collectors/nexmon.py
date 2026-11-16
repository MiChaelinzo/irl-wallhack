"""Real nexmon_csi collector for the Raspberry Pi 4B (BCM43455c0).

Runs `tcpdump -U -w -` on the CSI interface, decodes the libpcap stream with wallhack.nexmon and
produces one amplitude-in-dB reading per (transmitter, core, stream) link.

UNVERIFIED on hardware: tested only with synthetic frames built from the documented layout.
The command is always an argument list, never a shell string.
"""
import logging
import shutil
import subprocess
import threading
import time
from collections import deque
from typing import Deque, List, Optional

from ..nexmon import DEFAULT_PORT, FrameStats, frame_amplitude_db, iter_pcap_udp_payloads, parse_nexmon_payload
from .base import Collector, Reading

log = logging.getLogger("wallhack")

MAX_QUEUED_READINGS = 5000
STDERR_TAIL_LINES = 5
STDERR_JOIN_TIMEOUT_S = 1.0
FIRST_FRAME_WAIT_S = 2.0   # the first poll waits this long so the runtime's probe sees a live stream
THREAD_JOIN_S = 2.0
TERMINATE_WAIT_S = 2.0


def default_command(interface: str, port: int) -> List[str]:
    return ["tcpdump", "-i", interface, "-U", "-w", "-", "-s", "0", "udp", "and", "dst", "port", str(port)]


class NexmonCollector(Collector):
    name = "nexmon-csi"
    interval_s = 0.1

    def __init__(self, interface: str = "wlan0", port: int = DEFAULT_PORT, command: Optional[List[str]] = None):
        self.port = port
        self.command = list(command) if command else default_command(interface, port)
        self.last_error = ""
        self.dropped = 0
        self.stats = FrameStats()
        self._queue: Deque[Reading] = deque(maxlen=MAX_QUEUED_READINGS)
        self._stderr_tail: Deque[str] = deque(maxlen=STDERR_TAIL_LINES)
        self._proc: Optional[subprocess.Popen] = None
        self._threads: List[threading.Thread] = []
        self._first_frame = threading.Event()
        self._capture_ended = threading.Event()

    def available(self) -> bool:
        return shutil.which(self.command[0]) is not None

    def _start(self) -> None:
        proc = subprocess.Popen(self.command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._proc = proc
        self._capture_ended.clear()
        self._stderr_thread = threading.Thread(target=self._read_stderr, args=(proc,), name="wallhack-nexmon-stderr", daemon=True)
        self._frames_thread = threading.Thread(target=self._read_frames, args=(proc,), name="wallhack-nexmon", daemon=True)
        for t in (self._stderr_thread, self._frames_thread):
            t.start()
            self._threads.append(t)

    def _read_frames(self, proc: subprocess.Popen) -> None:
        try:
            for payload in iter_pcap_udp_payloads(proc.stdout, self.port):
                frame = parse_nexmon_payload(payload)
                if frame is None:
                    continue
                amp = frame_amplitude_db(frame)
                if amp is None:
                    continue
                self.stats.record(frame)
                if len(self._queue) == self._queue.maxlen:
                    self.dropped += 1
                self._queue.append(Reading(frame.link_id, amp, t=time.monotonic()))
                self._first_frame.set()
        except ValueError as exc:
            self.last_error = str(exc)
        except OSError as exc:
            self.last_error = str(exc)
        code = proc.wait()
        self._stderr_thread.join(STDERR_JOIN_TIMEOUT_S)  # stderr must be drained before it is reported
        if code != 0 and not self.last_error:
            self.last_error = " ".join(self._stderr_tail) or "capture exited with status %d" % code
        if self.last_error:
            log.warning("nexmon capture stopped: %s", self.last_error)
        self._capture_ended.set()

    def failure(self) -> str:
        """Why the capture process died, or "" while it runs (or died without an error)."""
        return self.last_error if self._capture_ended.is_set() else ""

    def _read_stderr(self, proc: subprocess.Popen) -> None:
        try:
            for line in proc.stderr:
                self._stderr_tail.append(line.decode("utf-8", "replace").strip())
        except (OSError, ValueError):
            return

    def poll(self) -> List[Reading]:
        if self._proc is None:
            self._start()
            self._first_frame.wait(FIRST_FRAME_WAIT_S)
        out: List[Reading] = []
        while self._queue:
            out.append(self._queue.popleft())
        return out

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(TERMINATE_WAIT_S)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        for t in self._threads:
            t.join(THREAD_JOIN_S)
        self._threads = []
        for stream in (proc.stdout, proc.stderr):
            stream.close()
