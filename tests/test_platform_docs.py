"""The platform documentation set exists and the top 100 list stays honest (Done rows cite real files)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLATFORM = ROOT / "docs" / "platform"
FILES = ["README.md", "01-repository-audit.md", "02-technical-debt.md", "03-architecture.md", "04-folder-structure.md",
         "05-component-map.md", "06-ai-planner-design.md", "material-database.md", "08-data-schemas.md",
         "09-rendering-optimization.md", "10-ui-modernization.md", "11-testing-strategy.md", "12-devops-strategy.md",
         "13-security-review.md", "14-deployment-plan.md", "15-wifi-physics.md", "16-educational-mode.md",
         "17-ar-computer-vision.md", "18-reporting-engine.md", "19-competitive-analysis.md", "20-roadmap.md",
         "21-top-100-improvements.md", "22-top-10-hackathon-features.md", "23-hackathon-pitch.md", "24-rf-lab-status.md",
         "adr-frontend-stack.md"]
EM_DASH = "\u2014"
STATUSES = ("Done", "Partial", "Not started")


def ranked_rows():
    rows = []
    for line in (PLATFORM / "21-top-100-improvements.md").read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 11 and cells[0].isdigit():
            rows.append(cells)
    return rows


def test_all_platform_documents_exist_and_are_not_empty():
    for name in FILES:
        path = PLATFORM / name
        assert path.is_file() and path.stat().st_size > 200, name


def test_documents_use_no_em_dash():
    for name in FILES + ["../../README.md", "../../CHANGELOG.md"]:
        assert EM_DASH not in (PLATFORM / name).read_text(encoding="utf-8"), name


def test_index_links_every_document():
    index = (PLATFORM / "README.md").read_text(encoding="utf-8")
    for name in FILES:
        if name != "README.md":
            assert name in index, name


def test_top_100_has_at_least_100_ranked_rows_in_order():
    rows = ranked_rows()
    assert len(rows) >= 100
    assert [int(r[0]) for r in rows] == list(range(1, len(rows) + 1))
    composites = [float(r[8]) for r in rows]
    assert composites == sorted(composites, reverse=True)
    assert all(r[9] in STATUSES for r in rows)


def test_composite_matches_the_stated_formula():
    for rank, title, impact, effort, tech, judge, user, innov, comp, _status, _ev in ranked_rows():
        i, e, t, j, u, n = (int(x) for x in (impact, effort, tech, judge, user, innov))
        assert all(1 <= v <= 5 for v in (i, e, t, j, u, n)), title
        assert abs(100 * (3 * i + 2 * u + 2 * t + 2 * j + n + 2 * (6 - e)) / 60 - float(comp)) < 0.06, title


def test_every_done_row_cites_existing_files():
    done = [r for r in ranked_rows() if r[9] == "Done"]
    assert done
    for row in done:
        paths = re.findall(r"`([^`]+)`", row[10])
        assert paths, f"Done row without a file: {row[1]}"
        for p in paths:
            assert (ROOT / p).exists(), f"{row[1]}: {p} does not exist"


def test_partial_rows_say_what_exists():
    for row in ranked_rows():
        if row[9] == "Partial":
            assert row[10] != "none", row[1]
