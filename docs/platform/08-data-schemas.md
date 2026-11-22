# 08 Data schemas

Shapes below are read from `wallhack/twin.py` (`validate_twin`, `sample_twin`), `wallhack/static/planner-state.js` (`validateProject`) and `wallhack/static/rf-config.json`. Limits come from `rf-config.json` `limits`. The only machine-readable schema in the repository is `wallhack/static/rf-config.schema.json` (JSON Schema 2020-12, validated by `tests/test_rf_config_schema.py`). The twin and project shapes are validated in code, not by a JSON Schema file.

## Twin and project JSON

Top level: `name` (text, at most 64 chars, blank becomes `Untitled`), `units` (`m`), `sample` (bool, optional), `mode` (optional propagation mode), `materials` (optional custom materials, at most 20), `floors` (1 to 6). The planner project file also has `schema_version` (currently 2, `planner-state.js` `SCHEMA_VERSION`; version 1 files still load).

Floor: `id`, `name`, `level` (int), `height_m` (2 to 6), `width_m` and `depth_m` (1 to 200 m), `rooms`, `walls`, `openings`, `furniture`, `sensors`, `aps`, optional `scale_m_per_px` and `background` (png, jpeg or webp data URL, at most 600000 characters). The planner adds `devices`, `annotations`, scenarios and capacity data (schema version 2). `twin.validate_twin` returns a normalised copy built from the fields it knows, and `grep` shows no `devices` or `annotations` handling in `wallhack/*.py`, so those planner-only fields are kept by the browser project file and are not stored by the server twin.

| Item | Fields |
|---|---|
| wall | `id`, `x1`, `y1`, `x2`, `y2`, `kind` (`interior` or `exterior`), optional `material` |
| opening | `id`, `kind` (`door` or `window`), `wall` (wall id), `pos`, `width` |
| room | `id`, `name`, `x`, `y`, `w`, `d` |
| furniture | `id`, `kind` (sofa, bed, table, desk, wardrobe, counter, other), `x`, `y`, `w`, `d` |
| sensor | `id`, `kind` (air, presence, rssi), `x`, `y` |
| ap | `id`, `x`, `y`, `tx_dbm`, optional `band` (`2.4`, `5`, `6`), `channel`, `width_mhz`, `standard`, `spatial_streams`, `mlo_bands`, `antenna_gain_dbi`, `azimuth_deg`, `pattern` (`omni`, `sector`), `beamwidth_deg`, `front_to_back_db`, `mesh_parent` |

Rules enforced (VERIFIED by `tests/test_twin.py`, `tests/test_planner_state.py`): ids unique per list, walls and items inside list limits (200 per list, 5000 walls and openings per floor), unknown band or standard rejected, `wifi7` 320 MHz only in 6 GHz, `wifi4` not on 6 GHz, channel must belong to the band, `mlo_bands` up to two other bands the standard allows.

Size limits: `PUT /api/twin` accepts up to `MAX_TWIN_BODY_BYTES` (about 23.5 MB, derived from the limits in `app.py`), other routes 1 MB.

Backwards compatibility: every new AP field is optional. A project without them yields identical numbers (golden fixture `tests/fixtures/rf_legacy_golden.json`).

## rf-config.json

Sections: `schema_version`, `label`, `source`, `limits`, `engine`, `bands`, `materials`, `kind_defaults`, `openings`, `floor_loss_db`, `analytics`, `mcs_tables`, `wifi_standards`, `interference`, `antenna`, `scoring`, `planner`, `planner_modes`. The schema file covers bands, materials, kind_defaults, floor_loss_db and wifi_standards; other sections are checked by the Python and JS loaders. Material entries are documented in [material-database.md](material-database.md).

## Report schema

The planner has no versioned report schema. What exists:

- Planner project and scenario files carry `schema_version` (`planner-state.js`).
- Analytics object (worker `analyze` result and `rfmodel.analytics`): coverage and dead-zone percentages, `quality_pct`, `aps` rows (id, band, channel, width, served area, usable Mbps, client capacity, utilisation, co-channel neighbours), `dead_zones` (area, centroid, bbox), overlap, optional SINR section.
- CSV rows from `PlannerExport.analyticsRows`.
- PDF built by `PlannerExport.buildReport(data)` from the same data.

Gap: the analytics object and the CSV and PDF outputs carry no version, and there is no JSON Schema for the analytics object or the project file, so external tools cannot validate them. Proposal (DESIGN ONLY): a schema file for the project and analytics objects next to `rf-config.schema.json`, tested the same way.
