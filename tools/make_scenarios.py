#!/usr/bin/env python3
"""Generate wallhack/static/scenarios.json, the planner scenario library (illustrative layouts, not real buildings).

The output is deterministic. tests/test_scenarios.py fails when the checked-in file differs from this script's output.

    python3 tools/make_scenarios.py [--check]
"""
import argparse
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "wallhack" / "static" / "scenarios.json"
LABEL = "Illustrative layouts for planning practice. Not real buildings. Coverage from them is a MODEL ESTIMATE."


class Floor:
    """One floor under construction: exterior ring, interior partitions with doors, rooms and APs."""

    def __init__(self, fid, name, level, w, d, exterior, interior, height=2.7):
        self.f = {"id": fid, "name": name, "level": level, "height_m": height, "width_m": w, "depth_m": d,
                  "rooms": [], "walls": [], "openings": [], "furniture": [], "sensors": [], "aps": []}
        self.exterior, self.interior, self.n = exterior, interior, 0
        for i, (x1, y1, x2, y2) in enumerate([(0, 0, w, 0), (w, 0, w, d), (w, d, 0, d), (0, d, 0, 0)]):
            self.f["walls"].append({"id": "%s-x%d" % (fid, i), "x1": x1, "y1": y1, "x2": x2, "y2": y2, "kind": "exterior", "material": exterior})

    def wall(self, x1, y1, x2, y2, material=None, door=None, kind="interior"):
        self.n += 1
        wid = "%s-i%d" % (self.f["id"], self.n)
        self.f["walls"].append({"id": wid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "kind": kind, "material": material or self.interior})
        if door is not None:
            self.f["openings"].append({"id": wid + "-door", "kind": "door", "wall": wid, "pos": door, "width": 0.9})
        return self

    def window(self, ring_index, pos, width=1.6):
        wid = "%s-x%d" % (self.f["id"], ring_index)
        self.f["openings"].append({"id": "%s-win%d" % (self.f["id"], len(self.f["openings"])), "kind": "window", "wall": wid, "pos": pos, "width": width})
        return self

    def room(self, rid, name, x, y, w, d):
        self.f["rooms"].append({"id": rid, "name": name, "x": x, "y": y, "w": w, "d": d})
        return self

    def void(self, vid, kind, x, y, w, d):
        """A stairwell, atrium or shaft: the slab is open there, so floor loss drops for paths that start or end inside it."""
        self.f.setdefault("voids", []).append({"id": vid, "kind": kind, "x": x, "y": y, "w": w, "d": d})
        return self

    def ap(self, aid, x, y, tx=20.0, **extra):
        """An AP with a WiFi standard, so SINR and throughput estimates exist for every preset."""
        self.f["aps"].append(dict({"id": aid, "x": x, "y": y, "tx_dbm": tx, "standard": "wifi6"}, **extra))
        return self


def scenario(sid, name, description, floors, interferers=None, learn=None):
    project = {"name": name, "units": "m", "sample": True, "floors": [f.f for f in floors]}
    if interferers:
        project["interferers"] = interferers
    return {"id": sid, "name": name, "description": description, "learn": learn or "", "project": project}


def small_apartment():
    f = Floor("main", "Apartment", 0, 8.0, 6.0, "brick", "drywall", 2.5)
    f.wall(4.0, 0, 4.0, 6.0, "concrete", door=2.5).wall(4.0, 3.0, 8.0, 3.0, "concrete", door=1.0).window(0, 2.0).window(1, 1.5)
    f.room("living", "Living room", 0, 0, 4, 6).room("kitchen", "Kitchen", 4, 0, 4, 3).room("bedroom", "Bedroom", 4, 3, 4, 3)
    f.ap("router", 0.8, 5.2, 18.0)
    return scenario("small_apartment", "Small apartment", "One router in the corner of a 48 m2 flat. The bedroom is the far end.",
                    [f], [{"id": "microwave", "kind": "microwave", "floor": "main", "x": 7.0, "y": 0.8}],
                    "Distance and two concrete partitions between router and bedroom. Move the router toward the middle.")


def large_home():
    g = Floor("ground", "Ground floor", 0, 16.0, 10.0, "brick", "drywall")
    g.wall(8.0, 0, 8.0, 10.0, door=5.0).wall(0, 5.0, 8.0, 5.0, door=3.0).wall(8.0, 6.0, 16.0, 6.0, door=4.0)
    g.window(0, 4.0).window(0, 12.0).window(2, 6.0)
    g.room("lounge", "Lounge", 0, 0, 8, 5).room("dining", "Dining", 0, 5, 8, 5).room("kitchen", "Kitchen", 8, 0, 8, 6).room("study", "Study", 8, 6, 8, 4)
    g.ap("router", 2.0, 2.0, 20.0)
    u = Floor("upper", "Upper floor", 1, 16.0, 10.0, "brick", "drywall")
    u.wall(5.0, 0, 5.0, 10.0, door=5.0).wall(11.0, 0, 11.0, 10.0, door=5.0).wall(5.0, 5.0, 16.0, 5.0, door=8.0)
    u.room("bed1", "Bedroom 1", 0, 0, 5, 10).room("bed2", "Bedroom 2", 5, 0, 6, 5).room("bed3", "Bedroom 3", 5, 5, 6, 5).room("bath", "Bathroom", 11, 0, 5, 10)
    return scenario("large_home", "Large home", "Two floors with one router in a downstairs corner. The upper floor and the far side are weak.",
                    [g, u], None, "A floor slab adds loss. Add an AP on the upper floor and compare coverage.")


def office_floor():
    f = Floor("office", "Office floor", 0, 30.0, 18.0, "glass", "office_partition")
    for x in (10.0, 20.0):
        f.wall(x, 0, x, 7.0, door=3.5)
    f.wall(0, 7.0, 30.0, 7.0, door=5.0).wall(0, 11.0, 30.0, 11.0, door=25.0)
    f.wall(12.0, 11.0, 12.0, 18.0, "concrete", door=3.5)
    f.room("meet1", "Meeting 1", 0, 0, 10, 7).room("meet2", "Meeting 2", 10, 0, 10, 7).room("meet3", "Meeting 3", 20, 0, 10, 7)
    f.room("corridor", "Corridor", 0, 7, 30, 4).room("open", "Open plan", 12, 11, 18, 7).room("core", "Service core", 0, 11, 12, 7)
    f.ap("ap-west", 5.0, 9.0, 18.0, band="2.4", channel=1).ap("ap-mid", 15.0, 9.0, 18.0, band="2.4", channel=1)
    f.ap("ap-east", 25.0, 9.0, 18.0, band="2.4", channel=1)
    neighbour = {"id": "neighbour-tower", "kind": "neighbour_wifi", "floor": "office", "x": 29.0, "y": 16.0, "band": "2.4", "channel": 6}
    return scenario("office_floor", "Office floor", "Three APs that all sit on channel 1 along a corridor, plus a neighbouring network on channel 6.",
                    [f], [neighbour], "Co-channel interference: APs on the same channel share airtime. Run the channel plan.")


def school_building():
    f = Floor("school", "School floor", 0, 40.0, 20.0, "brick", "brick")
    f.wall(0, 8.0, 40.0, 8.0, "drywall", door=4.0)
    f.wall(0, 12.0, 40.0, 12.0, "drywall", door=36.0)
    for i in range(1, 4):
        f.wall(10.0 * i, 0, 10.0 * i, 8.0, door=4.0)
        f.wall(10.0 * i, 12.0, 10.0 * i, 20.0, door=4.0)
    for i in range(4):
        f.room("n%d" % i, "Classroom N%d" % (i + 1), 10 * i, 0, 10, 8).room("s%d" % i, "Classroom S%d" % (i + 1), 10 * i, 12, 10, 8)
    f.room("corridor", "Corridor", 0, 8, 40, 4)
    f.ap("ap-1", 5.0, 10.0, 20.0, band="5").ap("ap-2", 20.0, 10.0, 20.0, band="5").ap("ap-3", 35.0, 10.0, 20.0, band="5")
    return scenario("school_building", "School building", "Brick classrooms on both sides of a corridor with three corridor APs at 5 GHz.",
                    [f], None, "Brick walls cost far more than drywall. Corridor APs reach classrooms only through the doors.")


def warehouse():
    f = Floor("hall", "Warehouse", 0, 40.0, 25.0, "industrial_wall", "metal", 6.0)
    for x in (10.0, 20.0, 30.0):
        f.wall(x, 4.0, x, 21.0, "metal")
    f.wall(0, 4.0, 6.0, 4.0, "drywall", door=3.0)
    f.room("racks", "Rack aisles", 0, 4, 40, 17).room("dock", "Loading dock", 0, 21, 40, 4).room("office", "Office", 0, 0, 6, 4)
    f.ap("ap-dock", 3.0, 2.0, 20.0, band="2.4").ap("ap-hall", 38.0, 12.0, 20.0, band="2.4")
    return scenario("warehouse", "Warehouse", "Metal racking forms long aisles. One AP in the office and one at the far end.",
                    [f], None, "Metal blocks signal almost completely. Aisles between racks act like corridors.")


def hotel_floor():
    f = Floor("hotel", "Guest floor", 0, 36.0, 14.0, "concrete", "concrete", 2.8)
    f.wall(0, 6.0, 36.0, 6.0, "drywall").wall(0, 8.0, 36.0, 8.0, "drywall")
    for i in range(1, 6):
        f.wall(6.0 * i, 0, 6.0 * i, 6.0, "concrete", door=2.0)
        f.wall(6.0 * i, 8.0, 6.0 * i, 14.0, "concrete", door=2.0)
    for i in range(6):
        f.room("a%d" % i, "Room %d" % (101 + i), 6 * i, 0, 6, 6).room("b%d" % i, "Room %d" % (111 + i), 6 * i, 8, 6, 6)
    f.room("corridor", "Corridor", 0, 6, 36, 2)
    f.ap("ap-west", 6.0, 7.0, 17.0, band="5").ap("ap-east", 30.0, 7.0, 17.0, band="5")
    return scenario("hotel_floor", "Hotel floor", "Concrete guest rooms along a corridor with two corridor APs.",
                    [f], None, "Concrete room walls leave the corridor APs reaching only nearby rooms. Consider one AP per few rooms.")


def coffee_shop():
    f = Floor("shop", "Coffee shop", 0, 12.0, 8.0, "glass", "drywall", 3.0)
    f.wall(8.0, 0, 8.0, 8.0, "drywall", door=4.0)
    f.window(0, 4.0, 3.0).window(2, 6.0, 3.0)
    f.room("seating", "Seating", 0, 0, 8, 8).room("bar", "Bar and kitchen", 8, 0, 4, 8)
    f.ap("ap-shop", 10.0, 4.0, 18.0)
    return scenario("coffee_shop", "Coffee shop", "Open seating with the router behind the bar. A microwave and Bluetooth speaker share the 2.4 GHz band.",
                    [f], [{"id": "microwave", "kind": "microwave", "floor": "shop", "x": 11.0, "y": 1.0},
                          {"id": "speaker", "kind": "bluetooth", "floor": "shop", "x": 3.0, "y": 4.0}],
                    "Interference sources raise the noise floor and lower SINR even when RSSI looks fine.")


def hospital_ward():
    f = Floor("ward", "Hospital ward", 0, 40.0, 20.0, "reinforced_concrete", "drywall", 3.0)
    f.wall(0, 8.0, 40.0, 8.0, "drywall", door=3.0).wall(0, 12.0, 40.0, 12.0, "drywall", door=34.0)
    for i in range(1, 5):
        f.wall(8.0 * i, 0, 8.0 * i, 8.0, "drywall", door=3.5)
        f.wall(8.0 * i, 12.0, 8.0 * i, 20.0, "drywall", door=3.5)
    f.wall(32.0, 12.0, 32.0, 20.0, "steel", door=3.5, kind="interior")
    for i in range(5):
        f.room("n%d" % i, "Ward %d" % (i + 1), 8 * i, 0, 8, 8)
    for i in range(4):
        f.room("s%d" % i, "Ward %d" % (i + 6), 8 * i, 12, 8, 8)
    f.room("imaging", "Imaging suite", 32, 12, 8, 8).room("corridor", "Corridor", 0, 8, 40, 4)
    f.ap("ap-west", 7.0, 10.0, 18.0, band="5", channel=36).ap("ap-mid", 20.0, 10.0, 18.0, band="5", channel=36)
    f.ap("ap-east", 33.0, 10.0, 18.0, band="5", channel=36)
    return scenario("hospital_ward", "Hospital ward", "Drywall wards along a corridor, a steel lined imaging suite and three corridor APs that all use channel 36.",
                    [f], [{"id": "staff-microwave", "kind": "microwave", "floor": "ward", "x": 4.0, "y": 10.5}],
                    "Medical devices and clinical apps need dependable roaming. Walk a path down the corridor in Timeline and check the handoffs, then run the channel plan.")


def smart_home():
    g = Floor("ground", "Ground floor", 0, 12.0, 9.0, "brick", "drywall", 2.6)
    g.wall(6.0, 0, 6.0, 9.0, "drywall", door=4.0).wall(0, 5.0, 6.0, 5.0, "drywall", door=2.0).window(0, 3.0).window(2, 7.0)
    g.room("living", "Living room", 6, 0, 6, 9).room("kitchen", "Kitchen", 0, 0, 6, 5).room("hall", "Hall", 0, 5, 6, 4)
    g.ap("router", 2.0, 7.0, 17.0, band="5")
    g.f["clients"] = [{"id": "tv", "device": "tv", "x": 10.0, "y": 4.0}, {"id": "cam", "device": "camera", "x": 11.0, "y": 8.0},
                      {"id": "phone", "device": "phone", "x": 3.0, "y": 2.0}, {"id": "plug", "device": "iot", "x": 9.0, "y": 1.0}]
    u = Floor("upper", "Upper floor", 1, 12.0, 9.0, "brick", "drywall", 2.6)
    u.wall(4.0, 0, 4.0, 9.0, "drywall", door=4.0).wall(8.0, 0, 8.0, 9.0, "drywall", door=4.0)
    u.room("bed1", "Bedroom 1", 0, 0, 4, 9).room("bed2", "Bedroom 2", 4, 0, 4, 9).room("study", "Study", 8, 0, 4, 9)
    u.f["clients"] = [{"id": "tablet", "device": "phone", "x": 10.0, "y": 4.0}, {"id": "console", "device": "console", "x": 6.0, "y": 6.0}]
    return scenario("smart_home", "Smart home", "A router downstairs, clients on both floors (TV, camera, console, laptop) and no AP upstairs.",
                    [g, u], None, "Use Recommendations to see whether a mesh node upstairs beats moving the router.")


def apartment_neighbours():
    f = Floor("flat", "Flat 3B", 0, 10.0, 7.0, "concrete", "drywall", 2.5)
    f.wall(5.0, 0, 5.0, 7.0, "drywall", door=3.0).window(1, 2.0)
    f.room("living", "Living room", 0, 0, 5, 7).room("bedroom", "Bedroom", 5, 0, 5, 7)
    f.ap("router", 1.0, 6.0, 17.0, band="2.4", channel=6)
    neighbours = [{"id": "flat-3a", "kind": "neighbour_wifi", "floor": "flat", "x": 0.2, "y": 3.0, "band": "2.4", "channel": 6},
                  {"id": "flat-3c", "kind": "neighbour_wifi", "floor": "flat", "x": 9.8, "y": 3.0, "band": "2.4", "channel": 6},
                  {"id": "flat-2b", "kind": "neighbour_wifi", "floor": "flat", "x": 5.0, "y": 0.2, "band": "2.4", "channel": 11}]
    return scenario("apartment_neighbours", "Apartment with neighbours", "A flat between two others, with concrete party walls and three neighbour networks, two on the router's channel 6.",
                    [f], neighbours, "Shared concrete walls shield the signal but neighbours still raise the noise on channel 6. Run the SINR channel plan and compare.")


def studio_apartment():
    f = Floor("studio", "Studio", 0, 6.0, 5.0, "brick", "drywall", 2.5)
    f.wall(4.0, 0, 4.0, 2.5, door=1.0).wall(4.0, 2.5, 6.0, 2.5).window(0, 1.5, 1.4).window(2, 1.5, 1.4)
    f.room("main", "Main room", 0, 0, 4, 5).room("bath", "Bathroom", 4, 0, 2, 2.5).room("kitchenette", "Kitchenette", 4, 2.5, 2, 2.5)
    f.ap("router", 0.8, 4.2, 17.0)
    return scenario("studio_apartment", "Studio apartment", "A 30 m2 studio with one open room, a small bathroom and a kitchenette. The router sits by the sofa.",
                    [f], [{"id": "microwave", "kind": "microwave", "floor": "studio", "x": 5.2, "y": 3.5}],
                    "A small open space is easy to cover. The bathroom is the weak spot, so test the router position.")


def two_bedroom_condo():
    f = Floor("condo", "Condo", 0, 10.0, 8.0, "concrete", "drywall", 2.5)
    f.wall(5.0, 0, 5.0, 3.5, door=1.0).wall(5.0, 3.5, 5.0, 5.5, door=0.6).wall(5.0, 5.5, 5.0, 8.0, door=1.0)
    f.wall(5.0, 3.5, 10.0, 3.5).wall(5.0, 5.5, 10.0, 5.5).window(0, 1.5, 1.8).window(0, 7.0, 1.4).window(2, 2.0, 1.8)
    f.room("living", "Living and kitchen", 0, 0, 5, 8).room("bed1", "Bedroom 1", 5, 0, 5, 3.5)
    f.room("bath", "Bathroom", 5, 3.5, 5, 2).room("bed2", "Bedroom 2", 5, 5.5, 5, 2.5)
    f.ap("router", 2.0, 4.0, 18.0)
    neighbour = {"id": "unit-4b", "kind": "neighbour_wifi", "floor": "condo", "x": 9.8, "y": 4.5, "band": "2.4", "channel": 6}
    return scenario("two_bedroom_condo", "Two bedroom condo", "A concrete shell condo with a living area on the left and two bedrooms and a bathroom on the right.",
                    [f], [neighbour], "The concrete shell shields neighbours, but the drywall partitions still cost the bedrooms signal. Compare a central router with a mesh node.")


def three_story_house():
    floors = []
    names = [("ground", "Ground floor", 0), ("first", "First floor", 1), ("second", "Second floor", 2)]
    for fid, name, level in names:
        f = Floor(fid, name, level, 12.0, 9.0, "brick", "drywall", 2.6)
        f.void(fid + "-stairs", "stairwell", 5.0, 3.0, 2.0, 3.0)
        floors.append(f)
    g, a, b = floors
    g.wall(8.0, 0, 8.0, 9.0, door=4.0).wall(0, 6.0, 8.0, 6.0, door=2.0).window(0, 3.0).window(2, 7.0)
    g.room("living", "Living room", 0, 0, 8, 6).room("dining", "Dining", 0, 6, 8, 3).room("kitchen", "Kitchen", 8, 0, 4, 9)
    g.ap("router", 2.0, 4.0, 20.0)
    a.wall(4.0, 0, 4.0, 9.0, door=2.0).wall(8.0, 0, 8.0, 9.0, door=6.0)
    a.room("bed1", "Bedroom 1", 0, 0, 4, 9).room("landing", "Landing", 4, 0, 4, 9).room("bath", "Bathroom", 8, 0, 4, 9)
    b.wall(6.0, 0, 6.0, 9.0, door=2.0)
    b.room("bed2", "Bedroom 2", 0, 0, 6, 9).room("study", "Study", 6, 0, 6, 9)
    return scenario("three_story_house", "Three story house", "Three floors joined by a stairwell, with one router on the ground floor. Each floor up costs signal, except near the stairs.",
                    floors, None, "A stairwell opening lowers the floor loss near it. Try a mesh node on the first floor landing.")


def small_office():
    f = Floor("smalloffice", "Small office", 0, 15.0, 10.0, "glass", "office_partition", 2.7)
    f.wall(9.0, 0, 9.0, 4.0, door=1.5).wall(9.0, 4.0, 9.0, 7.0, door=1.0).wall(9.0, 7.0, 9.0, 10.0, "metal_door", door=1.0)
    f.wall(9.0, 4.0, 15.0, 4.0).wall(9.0, 7.0, 15.0, 7.0).window(0, 3.0, 2.0).window(2, 3.0, 2.0)
    f.room("open", "Open plan", 0, 0, 9, 10).room("meeting", "Meeting room", 9, 0, 6, 4)
    f.room("manager", "Manager office", 9, 4, 6, 3).room("server", "Server closet", 9, 7, 6, 3)
    f.ap("ap-main", 4.5, 5.0, 18.0, band="5")
    neighbour = {"id": "next-door", "kind": "neighbour_wifi", "floor": "smalloffice", "x": 0.3, "y": 9.7, "band": "5", "channel": 36}
    return scenario("small_office", "Small office", "A ten person office: open plan on the left, a meeting room, a manager office and a server closet behind a metal door on the right.",
                    [f], [neighbour], "A metal door makes the server closet a dead end for the AP. The meeting room is the test of a video call.")


def build() -> dict:
    return {"schema_version": 1, "label": LABEL,
            "scenarios": [small_apartment(), large_home(), office_floor(), school_building(), warehouse(), hotel_floor(), coffee_shop(),
                          hospital_ward(), smart_home(), apartment_neighbours(),
                          studio_apartment(), two_bedroom_condo(), three_story_house(), small_office()]}


def render() -> str:
    return json.dumps(build(), indent=1, sort_keys=True) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="exit 1 when the checked-in file is out of date")
    args = ap.parse_args()
    if args.check:
        return 0 if OUT.read_text(encoding="utf-8") == render() else 1
    OUT.write_text(render(), encoding="utf-8")
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
