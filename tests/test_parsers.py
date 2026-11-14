from pathlib import Path

import pytest

from wallhack.collectors.linux import parse_iw_link, parse_iw_scan, parse_nmcli
from wallhack.collectors.macos import parse_system_profiler
from wallhack.collectors.ping import PingCollector, parse_ping_ms
from wallhack.collectors.udp_csi import parse_csi_packet
from wallhack.collectors.windows import parse_netsh_interfaces, parse_netsh_networks

FX = Path(__file__).parent / "fixtures"


def fx(name):
    return (FX / name).read_text()


def test_iw_link():
    r = parse_iw_link(fx("iw_link.txt"))
    assert [(x.link, x.rssi) for x in r] == [("a4:2b:b0:11:22:33", -52.0)]
    assert parse_iw_link("Not connected.") == []


def test_iw_scan():
    r = parse_iw_scan(fx("iw_scan.txt"))
    assert [(x.link, x.rssi) for x in r] == [("a4:2b:b0:11:22:33", -52.0), ("10:20:30:40:50:60", -71.0)]


def test_nmcli():
    r = parse_nmcli("A4\\:2B\\:B0\\:11\\:22\\:33:80\nGARBAGE\n")
    assert len(r) == 1 and r[0].link == "a4:2b:b0:11:22:33" and r[0].rssi == -60.0


def test_netsh_interfaces():
    r = parse_netsh_interfaces(fx("netsh_interfaces.txt"))
    assert r[0].link == "a4:2b:b0:11:22:33" and r[0].rssi == -57.0
    assert parse_netsh_interfaces("There is 0 interfaces") == []


def test_netsh_networks():
    r = parse_netsh_networks(fx("netsh_networks.txt"))
    assert [(x.link, x.rssi) for x in r] == [("a4:2b:b0:11:22:33", -57.0), ("a4:2b:b0:11:22:34", -80.0)]


def test_system_profiler_uses_current_network_only():
    r = parse_system_profiler(fx("system_profiler.txt"))
    assert len(r) == 1 and r[0].rssi == -55.0 and r[0].link == "HomeNet"
    assert parse_system_profiler("nothing here") == []


def test_ping_parse_and_private_only():
    assert parse_ping_ms("64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=3.42 ms") == 3.42
    assert parse_ping_ms("Reply from 192.168.1.1: bytes=32 time<1ms TTL=64") == 1.0
    assert parse_ping_ms("timeout") is None
    PingCollector("192.168.1.1")
    with pytest.raises(ValueError):
        PingCollector("8.8.8.8")
    with pytest.raises(ValueError):
        PingCollector("example.com")


def test_udp_csi_packet():
    r = parse_csi_packet(b'{"link":"esp32-1","rssi":-50}')
    assert r.link == "esp32-1" and r.rssi == -50.0
    r = parse_csi_packet(b'{"link":"e","csi":[3,4,0,5]}')  # amplitudes 5 and 5
    assert abs(r.rssi - 13.9794) < 1e-3
    assert parse_csi_packet(b"not json") is None
    assert parse_csi_packet(b'{"rssi":-50}') is None
