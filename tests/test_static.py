import json
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


JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


def test_no_external_urls():
    for f in STATIC.iterdir():
        # The JSON Schema dialect identifier is a name, never fetched.
        text = f.read_text().replace(JSON_SCHEMA_DIALECT, "")
        assert not re.search(r"https?://", text), f"external URL in {f.name}"
        assert "//cdn" not in text


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("name", sorted(p.name for p in STATIC.glob("*.js")))
def test_js_syntax(name):
    res = subprocess.run(["node", "--check", str(STATIC / name)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr


def test_heart_rate_has_permanent_experimental_label(client):
    html = client.get("/").text
    match = re.search(r'id="heartVal".*?heart rate, bpm(.*?)</div>', html, re.S)
    assert match and "experimental" in match.group(1)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_empty_tile_hint_reports_actual_sensor_status():
    source = (STATIC / "app.js").read_text()
    fn = re.search(r"function emptyTileHint\(env\) \{.*?\n  \}\n", source, re.S).group(0)
    script = (
        'var SENSORS_HINT = "no sensor. Start with --sensors";' + fn +
        'var out = [emptyTileHint(null), emptyTileHint({sensors: {}}),'
        ' emptyTileHint({sensors: {scd4x: {state: "error", message: "CRC error"}, pms5003: {state: "ok", message: ""}}}),'
        ' emptyTileHint({sensors: {ens160: {state: "warming", message: "warming up"}}}),'
        ' emptyTileHint({sensors: {pms5003: {state: "ok", message: ""}}})];'
        'console.log(JSON.stringify(out));'
    )
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    import json
    none_env, no_sensors, errored, warming, ok_no_data = json.loads(res.stdout)
    assert none_env == no_sensors == "no sensor. Start with --sensors"
    assert "scd4x error (CRC error)" in errored and "pms5003" not in errored
    assert "ens160 warming" in warming
    assert "--sensors" not in ok_no_data


def test_quality_selector_and_persistence_wired():
    html = (STATIC / "index.html").read_text()
    assert 'id="quality3d"' in html
    for level in ("low", "medium", "high"):
        assert f'<option value="{level}"' in html
    app_js = (STATIC / "app.js").read_text()
    assert "wallhack.quality" in app_js
    assert "Room3D.setQuality" in app_js


def test_view3d_honours_reduced_motion():
    js = (STATIC / "view3d.js").read_text()
    assert "prefers-reduced-motion" in js
    assert "STILL_TIME" in js


def test_dashboard_has_digital_twin_panels(client):
    html = client.get("/").text
    for element_id in ("scoreStrip", "floorSel", "viewMode", "heatToggle", "tlSlider", "playBadge", "insightsBody",
                       "insightsReco", "llmExplain", "homeGrid", "healthCard", "dsList", "dsSave", "gameCanvas", "gameCands"):
        assert f'id="{element_id}"' in html, element_id
    for script in ("twin.js", "panels.js", "game.js"):
        assert f'src="/static/{script}"' in html


def test_health_mode_labels_unsupported_metrics(client):
    html = client.get("/").text
    assert "Not medical data. For research purposes only." in html
    for label in ("Mood", "Perspiration", "Thoughts", "Through-wall imaging"):
        assert f"{label}: Not supported" in html, label
    assert "Experimental" in html


def test_llm_panel_is_labelled_unverified(client):
    assert "UNVERIFIED" in client.get("/").text


def test_new_scripts_have_no_inline_handlers_or_scripts(client):
    html = client.get("/").text
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html)
    assert not re.search(r"\son(click|load|change)=", html)


def test_mobile_and_judge_pages_served_without_inline_script(client):
    for path, ids in (("/mobile", ("mBadge", "mNotify", "mAlerts", "mEnv", "mSim")), ("/judge", ("jItems", "jVerified", "jUnverified", "jUnbuilt"))):
        html = client.get(path).text
        for element_id in ids:
            assert f'id="{element_id}"' in html, (path, element_id)
        assert not re.search(r"<script(?![^>]*\bsrc=)", html) and not re.search(r"\son\w+=", html), path
        for ref in re.findall(r'src="(/static/[^"]+)"', html) + re.findall(r'href="(/static/[^"]+)"', html):
            assert client.get(ref).status_code == 200, ref


def test_dashboard_has_pairing_card_and_nav(client):
    html = client.get("/").text
    for element_id in ("pairShow", "pairQr", "pairUrl"):
        assert f'id="{element_id}"' in html
    assert 'src="/static/common.js"' in html and 'data-page="/judge"' in html and 'data-page="/mobile"' in html
    assert "--lan" in html and "Security." in html


def test_premium_css_respects_quality_and_reduced_motion():
    css = (STATIC / "style.css").read_text()
    assert "@supports not" in css and "backdrop-filter" in css
    assert 'html[data-quality="low"]' in css and 'html[data-quality="high"]' in css
    assert css.count("prefers-reduced-motion") >= 2


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_common_particles_follow_quality_and_are_seeded():
    script = (
        'const c = require(process.argv[1]);'
        'console.log(JSON.stringify([c.particleCount("low"), c.particleCount("medium"), c.particleCount("high"), c.particleCount("bogus"),'
        ' JSON.stringify(c.particles(5)) === JSON.stringify(c.particles(5)), c.particles(64).every(p => p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1)]));'
    )
    res = subprocess.run(["node", "-e", script, str(STATIC / "common.js")], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    import json
    low, medium, high, bogus, same, inside = json.loads(res.stdout)
    assert low == 0 and 0 < medium < high and bogus == medium and same and inside


def test_planner_page_is_served_with_only_same_origin_scripts(client):
    html = client.get("/planner").text
    for element_id in ("cEdit", "cHeat", "cBase", "cOver", "estimateLabel", "legend", "minimap", "undoBtn", "palette", "imageFile", "themeBtn"):
        assert f'id="{element_id}"' in html, element_id
    assert "MODEL ESTIMATE, not a measurement" in html
    assert not re.search(r"<script(?![^>]*\bsrc=)", html) and not re.search(r"\son\w+=", html)
    assert not re.search(r"https?://", re.sub(r"docs/rf-planner\.md", "", html)), "planner must work offline, no external URLs"
    scripts = re.findall(r'<script[^>]*src="([^"]+)"', html)
    assert scripts and all(s.startswith("/static/") for s in scripts)
    for ref in scripts + re.findall(r'href="(/static/[^"]+)"', html):
        assert client.get(ref).status_code == 200, ref


def test_planner_is_linked_from_every_page(client):
    for path in ("/", "/judge", "/mobile", "/planner"):
        assert 'data-page="/planner"' in client.get(path).text, path


def test_vercel_csp_allows_same_origin_workers():
    csp = json.loads((STATIC.parent.parent / "vercel.json").read_text())["headers"][0]["headers"][0]["value"]
    assert "worker-src 'self'" in csp and "script-src 'self'" in csp and "unsafe-eval" not in csp
