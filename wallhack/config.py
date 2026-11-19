"""Configuration: defaults < config.json < environment variables < CLI flags."""
import json
import logging
import os
from dataclasses import dataclass, asdict, field, fields
from typing import Optional

log = logging.getLogger("wallhack")

SOURCES = ("auto", "simulator", "real")
# IPv6 loopback is deliberately absent: Starlette's TrustedHostMiddleware splits the Host
# header on ":" and cannot parse "[::1]:8000", so Host protection would reject every request.
CSI_SOURCES = ("", "nexmon")
LOCAL_HOSTS = ("127.0.0.1", "localhost")
SENSORS = ("pms5003", "scd4x", "ens160", "ze08", "mlx90614")
DEFAULT_PMS_PORT = "/dev/serial0"       # Pi primary UART; PMS5003 on GPIO 14/15
DEFAULT_HCHO_PORT = "/dev/ttyUSB0"      # ZE08-CH2O through a USB-serial adapter
DEFAULT_I2C_BUS = 1                     # /dev/i2c-1 on Raspberry Pi
LLM_PROVIDERS = ("", "ollama", "llamacpp", "openai", "azure")   # keep in sync with llm.PROVIDERS
DEFAULT_DATA_DIR = "data"               # gitignored; holds twin.json and history.db


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
    udp_token: str = ""           # optional shared secret that UDP packets must include
    csi_source: str = ""          # "" or "nexmon" (Raspberry Pi 4 nexmon_csi via tcpdump)
    csi_port: int = 5500          # UDP port nexmon_csi sends frames to
    sensors: str = ""             # comma list from SENSORS; "" = no environment sensors
    serial_pms: str = DEFAULT_PMS_PORT
    serial_hcho: str = DEFAULT_HCHO_PORT
    i2c_bus: int = DEFAULT_I2C_BUS
    data_dir: str = field(default_factory=lambda: DEFAULT_DATA_DIR)  # read at call time so tests can redirect it
    history_enabled: bool = True  # keep a local SQLite history under data_dir
    history_step_s: float = 5.0   # seconds of sensing time between history rows
    history_max_rows: int = 17280  # retention limit: oldest rows are deleted beyond this
    llm_provider: str = ""        # "" = off; ollama | llamacpp (local) | openai | azure (cloud). Keys: env vars only
    llm_model: str = ""
    llm_endpoint: str = ""        # optional base URL override; never a secret
    llm_timeout_s: float = 30.0
    background: bool = True       # tests set False and step manually

    def sensor_names(self) -> tuple:
        """The configured sensors as a tuple, in the order given, without duplicates."""
        names = [n.strip().lower() for n in self.sensors.split(",") if n.strip()]
        return tuple(dict.fromkeys(names))

    def validate(self) -> None:
        unknown = [n for n in self.sensor_names() if n not in SENSORS]
        if unknown:
            raise ValueError(f"unknown sensors {unknown}; choose from {SENSORS}")
        if self.i2c_bus < 0:
            raise ValueError("i2c_bus must be 0 or greater")
        if self.source not in SOURCES:
            raise ValueError(f"source must be one of {SOURCES}")
        if not 0.25 <= self.sensitivity <= 4.0:
            raise ValueError("sensitivity must be between 0.25 and 4.0")
        if self.csi_source not in CSI_SOURCES:
            raise ValueError(f"csi_source must be one of {CSI_SOURCES}")
        if not 1 <= self.csi_port <= 65535:
            raise ValueError("csi_port must be 1-65535")
        if self.llm_provider not in LLM_PROVIDERS:
            raise ValueError(f"llm_provider must be one of {LLM_PROVIDERS}")
        if self.llm_timeout_s <= 0:
            raise ValueError("llm_timeout_s must be greater than 0")
        if self.history_step_s <= 0:
            raise ValueError("history_step_s must be greater than 0")
        if self.history_max_rows < 1:
            raise ValueError("history_max_rows must be at least 1")
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
