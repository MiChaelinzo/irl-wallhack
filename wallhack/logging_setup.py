"""Logging helpers: optional one-line JSON logs, request ids and a small rolling error counter.

JSON logs are off by default (config `log_json` or WALLHACK_LOG_JSON=1). Nothing here records request bodies,
headers or query strings, so secrets that travel in them (pairing tokens, API keys) never reach a log line.
"""
import json
import logging
import re
import threading
import time
import uuid
from collections import deque
from contextvars import ContextVar

REQUEST_ID_HEADER = "X-Request-ID"
REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{8,64}")   # a client may supply its own id, only if it is plain and short
ERROR_WINDOW_S = 3600.0
ERROR_LOG_MAX = 500          # remembered error events; older ones are dropped
TEXT_FORMAT = "%(asctime)s %(levelname)s %(message)s"

request_id_var: ContextVar = ContextVar("wallhack_request_id", default="-")


def new_request_id(supplied=None) -> str:
    """The client's id when it is a safe token, else a fresh random one."""
    if supplied and REQUEST_ID_PATTERN.fullmatch(supplied):
        return supplied
    return uuid.uuid4().hex[:16]


class JsonFormatter(logging.Formatter):
    """One JSON object per line: time, level, logger, message, request id and any `extra` fields named in EXTRA_KEYS."""
    EXTRA_KEYS = ("method", "path", "status", "duration_ms")

    def format(self, record: logging.LogRecord) -> str:
        out = {"time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"), "level": record.levelname, "logger": record.name,
               "message": record.getMessage(), "request_id": request_id_var.get()}
        for key in self.EXTRA_KEYS:
            if hasattr(record, key):
                out[key] = getattr(record, key)
        if record.exc_info:
            out["exception"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=True)


def configure_logging(json_logs: bool, level: int = logging.INFO) -> None:
    """Install the root handler. Replaces handlers installed earlier so calling it twice does not duplicate lines."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter() if json_logs else logging.Formatter(TEXT_FORMAT))
    root = logging.getLogger()
    for old in list(root.handlers):
        root.removeHandler(old)
    root.addHandler(handler)
    root.setLevel(level)


class ErrorLog:
    """Counts server errors (HTTP 5xx and unhandled exceptions) in a rolling window. Thread safe, keeps no messages."""

    def __init__(self, window_s: float = ERROR_WINDOW_S, clock=time.monotonic):
        self.window_s, self.clock = window_s, clock
        self._events = deque(maxlen=ERROR_LOG_MAX)
        self._lock = threading.Lock()
        self.total = 0

    def record(self, kind: str) -> None:
        with self._lock:
            self._events.append((self.clock(), kind))
            self.total += 1

    def recent(self) -> dict:
        cutoff = self.clock() - self.window_s
        with self._lock:
            kinds = [k for t, k in self._events if t >= cutoff]
        counts = {}
        for k in kinds:
            counts[k] = counts.get(k, 0) + 1
        return {"window_s": self.window_s, "count": len(kinds), "by_kind": counts, "total_since_start": self.total}
