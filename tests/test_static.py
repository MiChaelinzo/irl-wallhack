import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wallhack.app import STATIC, create_app
from wallhack.config import Config


@pytest.fixture()
def client():
    app = create_app(Config(source="simulator", background=False))
    with TestClient(app, base_url="http://localhost") as c:
        yield c


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "<canvas" in r.text
    assert "consent" in r.text.lower()
    assert "not produce images" in r.text


def test_dashboard_has_new_sections(client):
    html = client.get("/").text
    for element_id in ("room3d", "vitalsCard", "heartVal", "activityBadge", "envSection", "envGrid", "rotateBtn", "resetView"):
        assert f'id="{element_id}"' in html, element_id
    assert "Not imaging. Positions are schematic." in html
    assert "About these readings" in html
    assert "mood" in html.lower() and "perspiration" in html.lower()


def test_index_assets_exist_and_served(client):
    html = (STATIC / "index.html").read_text()
    refs = re.findall(r'(?:src|href)="(/static/[^"]+)"', html)
    assert refs, "index.html must reference its assets"
    for ref in refs:
        assert (STATIC / ref[len("/static/"):]).is_file(), ref
        assert client.get(ref).status_code == 200, ref


def test_no_external_urls():
    for f in STATIC.iterdir():
        text = f.read_text()
        assert not re.search(r"https?://", text), f"external URL in {f.name}"
        assert "//cdn" not in text


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("name", sorted(p.name for p in STATIC.glob("*.js")))
def test_js_syntax(name):
    res = subprocess.run(["node", "--check", str(STATIC / name)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
