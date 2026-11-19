"""Local SQLite history of downsampled sensing readings.

One row per HISTORY_STEP_S of sensing time. Data never leaves the machine. Old rows are pruned so the
file stays bounded. `t` is seconds on the runtime clock, which restarts when the data source is
reconfigured, so every row also carries a `session` number and queries default to the latest one.
"""
import sqlite3
import threading
from pathlib import Path
from typing import List, Optional

DEFAULT_STEP_S = 5.0
DEFAULT_MAX_ROWS = 17280          # 24 h at one row per 5 s
MAX_POINTS = 5000                 # upper bound on rows returned by one query
# column -> SQL aggregate used when a query downsamples several rows into one bucket
COLUMNS = {
    "occupancy": "MAX", "motion": "MAX", "breathing_bpm": "AVG", "heart_bpm": "AVG",
    "signal_dbm": "AVG", "csi_trend": "AVG", "pm25": "AVG", "co2": "AVG", "tvoc_ppb": "AVG",
    "temperature_c": "AVG", "humidity_pct": "AVG", "aqi": "AVG",
}
SCHEMA = ("CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY AUTOINCREMENT, session INTEGER NOT NULL, "
          "t REAL NOT NULL, " + ", ".join(f"{c} REAL" for c in COLUMNS) + ")")


class History:
    def __init__(self, path: str = ":memory:", max_rows: int = DEFAULT_MAX_ROWS):
        if max_rows < 1:
            raise ValueError("max_rows must be at least 1")
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.max_rows = max_rows
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(SCHEMA)
        self._db.execute("CREATE INDEX IF NOT EXISTS samples_session_t ON samples (session, t)")
        row = self._db.execute("SELECT COALESCE(MAX(session), 0) FROM samples").fetchone()
        self.session = row[0] + 1
        self._db.commit()

    def new_session(self) -> int:
        with self._lock:
            self.session += 1
            return self.session

    def record(self, t: float, **values: Optional[float]) -> None:
        unknown = set(values) - set(COLUMNS)
        if unknown:
            raise ValueError(f"unknown history columns {sorted(unknown)}")
        cols = ["session", "t"] + list(COLUMNS)
        row = [self.session, round(t, 2)] + [None if values.get(c) is None else float(values[c]) for c in COLUMNS]
        with self._lock:
            self._db.execute(f"INSERT INTO samples ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", row)
            (count,) = self._db.execute("SELECT COUNT(*) FROM samples").fetchone()
            if count > self.max_rows:
                self._db.execute("DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY id LIMIT ?)",
                                 (count - self.max_rows,))
            self._db.commit()

    def count(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM samples").fetchone()[0]

    def query(self, t_from: float = 0.0, t_to: Optional[float] = None, step: float = DEFAULT_STEP_S,
              session: Optional[int] = None) -> List[dict]:
        """Rows with t in [t_from, t_to], averaged into buckets of `step` seconds."""
        if step <= 0:
            raise ValueError("step must be greater than 0")
        if t_to is not None and t_to < t_from:
            raise ValueError("'to' must not be before 'from'")
        aggs = ", ".join(f"{fn}({c}) AS {c}" for c, fn in COLUMNS.items())
        sql = (f"SELECT CAST(t / ? AS INTEGER) * ? AS bucket, {aggs} FROM samples "
               "WHERE session = ? AND t >= ? AND (? IS NULL OR t <= ?) GROUP BY bucket ORDER BY bucket LIMIT ?")
        with self._lock:
            cur = self._db.execute(sql, (step, step, self.session if session is None else session,
                                         t_from, t_to, t_to, MAX_POINTS))
            names = ["t"] + list(COLUMNS)
            return [{n: (round(v, 2) if isinstance(v, float) else v) for n, v in zip(names, r)} for r in cur]

    def close(self) -> None:
        with self._lock:
            self._db.close()
