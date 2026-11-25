"""Render docs/platform/material-database.md from wallhack/static/rf-config.json.

Run `python3 tools/material_doc.py` to rewrite the document. tests/test_rf_config_schema.py fails when the
committed document differs from `render()`, so the table cannot drift from the config.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "wallhack" / "static" / "rf-config.json"
DOC_PATH = ROOT / "docs" / "platform" / "material-database.md"

COST_TEXT = {
    "wall_segment": "One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.",
    "reference_slab": "Same cost as a wall segment if drawn as a wall. The 2D engine has no slab geometry, so this entry is a reference value.",
}


def _fmt(value: float) -> str:
    return f"{value:g}"


def render(config: dict) -> str:
    bands = list(config["bands"])
    lines = [
        "# Material database",
        "",
        "Generated from `wallhack/static/rf-config.json` by `tools/material_doc.py`. Do not edit by hand, a test keeps it in sync.",
        "",
        "MODEL ESTIMATE: every figure is a rounded typical value, not a measurement. Calibrate with a site survey.",
        "",
        "Attenuation is the loss in dB for one wall crossing. Range is `min / typical / max` in dB. `typical` is the value the engine uses.",
        "Frequency exponent `n` is derived from the typical values as `ln(L6 / L2.4) / ln(f6 / f2.4)`, so loss scales roughly as `f^n`.",
        "",
        "| Material | Confidence | Frequency exponent | " + " | ".join(f"{b} GHz range (dB)" for b in bands) + " | " + " | ".join(f"{b} GHz reflection (dB)" for b in bands) + " |",
        "|---|---|---|" + "---|" * (2 * len(bands)),
    ]
    for mid, m in config["materials"].items():
        ranges = " | ".join("{} / {} / {}".format(*(_fmt(m["range_db"][b][k]) for k in ("min", "typical", "max"))) for b in bands)
        refl = " | ".join(_fmt(m["reflection_loss_db"][b]) for b in bands)
        lines.append(f"| {m['label']} (`{mid}`) | {m['confidence']} | {m['frequency_exponent']:g} | {ranges} | {refl} |")
    lines += [
        "",
        "## Derived fields",
        "",
        "Saved projects store only `attenuation_db` and `reflection_loss_db` per band. The planner and the engines derive the rest "
        "(`rfmodel.material_fields`, `RFEngine.materialFields`), nothing extra is stored:",
        "",
        "- `attenuation24GHz`, `attenuation5GHz`, `attenuation6GHz`: `attenuation_db` of that band, in dB.",
        "- `penetrationRate`: linear power fraction that passes one crossing, `10^(-attenuation_db / 10)`.",
        "- `reflectionRate`: linear power fraction reflected, `10^(-reflection_loss_db / 10)`.",
        "",
        "MODEL ESTIMATE: the rates only restate the typical dB values as fractions, they are not separate measurements. "
        "The table shows the rates per band.",
        "",
        "| Material | " + " | ".join(f"{b} GHz penetration" for b in bands) + " | " + " | ".join(f"{b} GHz reflection" for b in bands) + " |",
        "|---|" + "---|" * (2 * len(bands)),
    ]
    for mid, m in config["materials"].items():
        pen = " | ".join(f"{10 ** (-m['attenuation_db'][b] / 10):.4f}" for b in bands)
        ref = " | ".join(f"{10 ** (-m['reflection_loss_db'][b] / 10):.4f}" for b in bands)
        lines.append(f"| {m['label']} (`{mid}`) | {pen} | {ref} |")
    lines += ["", "## Notes, simulation cost and sources", ""]
    for mid, m in config["materials"].items():
        lines += [f"### {m['label']} (`{mid}`)", "", m["notes"], "",
                  f"- Simulation cost: {COST_TEXT[m['simulation_cost']]}"]
        lines += [f"- Source: {s}" for s in m["sources"]]
        lines.append("")
    lines += [
        "## Floors and roofing",
        "",
        "The 2D engine applies floors as a fixed `floor_loss_db` per floor crossed (`rf-config.json`). It has no slab or roof geometry. "
        "`flooring` and `roofing` are reference values for that figure and for a future 3D model. They can be picked as a wall material, "
        "which then models a thin partition, not a slab.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    DOC_PATH.parent.mkdir(parents=True, exist_ok=True)
    DOC_PATH.write_text(render(json.loads(CONFIG_PATH.read_text())))


if __name__ == "__main__":
    main()
