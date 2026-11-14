"""Configuration: defaults < config.json < environment variables < CLI flags."""
import json
import logging
import os
from dataclasses import dataclass, asdict, fields
from typing import Optional

log = logging.getLogger("wallhack")

SOURCES = ("auto", "simulator", "real")
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8000
    source: str = "auto"          # auto | simulator | real
    scenario: str = "demo"
    sensitivity: float = 1.0
    seed: int = 42
    interface: str = "wlan0"
    ping_target: str = ""         # optional private IP of your router (ping fallback)
    udp_port: int = 0             # >0 enables the ESP32 CSI UDP receiver
    udp_host: str = "127.0.0.1"
    background: bool = True       # tests set False and step manually

    def validate(self) -> None:
        if self.source not in SOURCES:
            raise ValueError(f"source must be one of {SOURCES}")
        if not 0.25 <= self.sensitivity <= 4.0:
            raise ValueError("sensitivity must be between 0.25 and 4.0")
        if not 1 <= self.port <= 65535:
            raise ValueError("port must be 1-65535")

    def warn_if_exposed(self) -> None:
        if self.host not in LOCAL_HOSTS:
            log.warning("Binding to %s exposes the dashboard to your network. "
                        "There is no authentication. Use 127.0.0.1 unless you trust the network.", self.host)


def load_config(path: Optional[str] = None, env=None) -> Config:
    env = os.environ if env is None else env
    cfg = Config()
    path = path or env.get("WALLHACK_CONFIG") or "config.json"
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        known = {f.name for f in fields(Config)}
        for k, v in data.items():
            if k in known:
                setattr(cfg, k, v)
            else:
                log.warning("ignoring unknown config key %r", k)
    for f in fields(Config):
        raw = env.get("WALLHACK_" + f.name.upper())
        if raw is None:
            continue
        cur = getattr(cfg, f.name)
        if isinstance(cur, bool):
            setattr(cfg, f.name, raw.lower() in ("1", "true", "yes"))
        else:
            setattr(cfg, f.name, type(cur)(raw))
    cfg.validate()
    return cfg


def as_dict(cfg: Config) -> dict:
    return asdict(cfg)
