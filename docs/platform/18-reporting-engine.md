# 18 Reporting engine audit

Audited file: `wallhack/static/planner-export.js` (332 lines), `wallhack/static/planner-modes.js` (the `boq` exporter), `docs/rf-planner.md`. Tests: `tests/test_planner_panels.py` (CSV, PDF structure), `tests/test_rf_planner_js.py`.

## What exists (registered exporters)

| Id | Output | Content | Status |
|---|---|---|---|
| `png` | PNG of the current view | plan, heat map, legend, annotations, MODEL ESTIMATE line | PARTIALLY VERIFIED (script run, not opened in a viewer) |
| `csv` | CSV analytics | label line, summary, quality bands, per-AP table (id, band, channel, width, served area, usable Mbps, client capacity, expected clients, utilisation, co-channel neighbours), dead zones | VERIFIED for escaping and formula-injection guard (`test_csv_escaping_and_formula_injection`) |
| `json` | Project JSON (`*.wallhack-plan.json`) | the full project, `schema_version` 2 | VERIFIED by import and validation tests |
| `pdf` | PDF coverage report, built by hand (PDF 1.4, Helvetica text, JPEG heat map via DCTDecode) | title, project, floor and date, an estimate banner, summary table (coverage at -70 dBm, mean RSSI, weak area, dead zones, overlap, roaming, mean throughput, client capacity), heat map image, per-AP table, issues and recommendations (empty until the Smart planner has run), footer | structure and signature checked by script; UNVERIFIED in a real viewer |
| `print` | Browser print dialog | the page | UNVERIFIED |
| `boq` | Bill of quantities CSV (enterprise mode) | AP count per band, mounting kits, PoE switch ports and switches, Cat6A cable length, from `planner_modes.enterprise` rule-of-thumb constants | PARTIALLY VERIFIED |

Scenario files (`wallhack-scenarios` JSON) are downloaded from the Scenarios tab.

New exporters register with `PlannerExport.register(id, {label, run(ctx)})`, so adding a type does not touch the core file.

## Gaps

| Gap | Impact |
|---|---|
| No report schema or version on CSV, PDF and analytics outputs (see [08-data-schemas.md](08-data-schemas.md)) | external tools cannot validate |
| The PDF reports the current floor only (`app.currentFloor()` in the `pdf` exporter) and has no per-room table | multi-floor buildings need one export per floor |
| No SINR or standards section in the PDF and CSV (the new fields exist in analytics) | the Wi-Fi 4 to 7 work is invisible in reports |
| No material list with sources and confidence in the report | weakens the honesty story |
| PDF text is Latin-1 only (`winAnsi`) | non-Latin room names degrade |
| No scenario comparison report (before and after with deltas) although `compareScenarios` exists | the most persuasive report is missing |
| No HTML report, no shareable link | |
| No measured-versus-predicted section (no survey data) | |
| PDF and PNG never opened in a real viewer | UNVERIFIED |

## Proposed order

1. Add SINR and standard columns to CSV and PDF (data already computed).
2. Add a before and after report from `compareScenarios`.
3. Add a materials appendix generated from `rf-config.json` (reuse the logic of `tools/material_doc.py`).
4. Add `report_schema_version` and a schema file with a test.
5. Open the PDF in a real viewer once and record the result.
