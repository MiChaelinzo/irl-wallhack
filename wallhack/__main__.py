"""python -m wallhack [--source simulator] [--open]"""
import argparse
import logging
import sys
import threading
import time
import webbrowser

import uvicorn

from .app import create_app
from .runtime import SourceUnavailableError
from .collectors.nexmon import NexmonCollector
from .config import CSI_SOURCES, LOCAL_HOSTS, load_config
from .nexmon import summarize

DEFAULT_CHECK_SECONDS = 10.0


def run_csi_check(collector: NexmonCollector, seconds: float) -> int:
    """Capture for `seconds`, print a summary and return the process exit code (0 if frames seen)."""
    deadline = time.monotonic() + seconds
    started = time.monotonic()
    try:
        while time.monotonic() < deadline:
            collector.poll()
            time.sleep(collector.interval_s)
    finally:
        collector.close()
    summary = summarize(collector.stats, time.monotonic() - started, collector.last_error)
    print(summary.render())
    return 0 if summary.ok else 1


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="wallhack", description="Local WiFi presence/motion/breathing sensing dashboard")
    p.add_argument("--source", choices=["auto", "simulator", "real"])
    p.add_argument("--scenario")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.add_argument("--seed", type=int)
    p.add_argument("--sensitivity", type=float)
    p.add_argument("--interface", help="WiFi interface on Linux (default wlan0)")
    p.add_argument("--ping-target", help="private IP of your own router (latency fallback)")
    p.add_argument("--udp-port", type=int, help="enable ESP32 CSI UDP receiver on this port")
    p.add_argument("--udp-host", help="address for the UDP receiver (default 127.0.0.1; use 0.0.0.0 for an ESP32 on your LAN)")
    p.add_argument("--udp-token", help="shared secret UDP packets must carry in a \"token\" field")
    p.add_argument("--csi-source", choices=[c for c in CSI_SOURCES if c], help="real CSI source: nexmon = Raspberry Pi 4 nexmon_csi via tcpdump")
    p.add_argument("--csi-port", type=int, help="UDP port nexmon_csi sends to (default 5500)")
    p.add_argument("--csi-check", nargs="?", const=DEFAULT_CHECK_SECONDS, type=float, metavar="SECONDS",
                   help="capture nexmon CSI for SECONDS (default 10), print a diagnosis and exit")
    p.add_argument("--config", help="path to config.json")
    p.add_argument("--open", action="store_true", help="open the dashboard in your browser (default when run from a terminal)")
    p.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(a.config)
    for name in ("source", "scenario", "host", "port", "seed", "sensitivity", "interface", "ping_target", "udp_port", "udp_host", "udp_token", "csi_source", "csi_port"):
        v = getattr(a, name)
        if v is not None:
            setattr(cfg, name, v)
    cfg.validate()
    if a.csi_check is not None:
        collector = NexmonCollector(cfg.interface, cfg.csi_port)
        if not collector.available():
            raise SystemExit("error: tcpdump not found on PATH (sudo apt install tcpdump)")
        raise SystemExit(run_csi_check(collector, a.csi_check))
    cfg.warn_if_exposed()
    if cfg.udp_port > 0 and cfg.udp_host not in LOCAL_HOSTS and not cfg.udp_token:
        logging.getLogger("wallhack").warning(
            "UDP receiver on %s has no --udp-token: anyone on the network can send fake readings.", cfg.udp_host)
    url = f"http://{cfg.host}:{cfg.port}/"
    print(f"Wallhack dashboard: {url}  (Ctrl+C to stop)")
    if a.open or (not a.no_browser and sys.stdin.isatty()):
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    try:
        app = create_app(cfg)
    except SourceUnavailableError as exc:
        raise SystemExit(f"error: {exc}")
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="warning")


if __name__ == "__main__":
    main()
