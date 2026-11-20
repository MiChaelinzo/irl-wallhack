"""The judge page may not claim more than the README verification table."""
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wallhack import judge
from wallhack.app import create_app
from wallhack.config import Config

README = (Path(__file__).resolve().parent.parent / "README.md").read_text(encoding="utf-8")
LABEL = re.compile(r"PARTIALLY VERIFIED|UNVERIFIED|VERIFIED|NOT BUILT")


def row_label(anchor):
    rows = [r for r in README.split("\n") if r.startswith("|") and anchor in r]
    assert rows, f"README verification table has no row containing {anchor!r}"
    return LABEL.search(rows[0].split("|")[2]).group(0)


def test_every_item_matches_its_readme_row():
    for item in judge.ITEMS:
        assert item["verification"] == row_label(item["evidence"]), item["id"]


def test_statuses_are_consistent_with_verification():
    for item in judge.ITEMS:
        assert item["status"] in judge.STATUSES and item["verification"] in judge.LABELS
        assert (item["verification"] == "NOT BUILT") == (item["status"] in (judge.FUTURE, judge.UNSUPPORTED)), item["id"]
        if item["status"] == judge.BUILT:
            assert item["verification"] != "UNVERIFIED", item["id"]


def test_required_classifications():
    by_id = {i["id"]: i for i in judge.ITEMS}
    assert by_id["automation"]["status"] == judge.FUTURE and by_id["enterprise"]["status"] == judge.FUTURE
    assert by_id["llm"]["status"] == judge.EXPERIMENTAL and by_id["llm"]["verification"] == "UNVERIFIED"
    for key in ("mood", "sweat", "thoughts", "imaging"):
        assert by_id[key]["status"] == judge.UNSUPPORTED
    assert len({i["id"] for i in judge.ITEMS}) == len(judge.ITEMS)


@pytest.fixture()
def client():
    with TestClient(create_app(Config(source="simulator", background=False)), base_url="http://localhost") as c:
        yield c


def test_judge_endpoint_and_pages(client):
    data = client.get("/api/judge").json()
    assert [i["id"] for i in data["items"]] == [i["id"] for i in judge.ITEMS]
    assert client.get("/judge").status_code == 200 and client.get("/mobile").status_code == 200
