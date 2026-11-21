# RF planner

## Propagation model

MODEL ESTIMATE, not a measurement. Implemented in `wallhack/rfmodel.py` (reference) and
`wallhack/static/rf-engine.js` (port). Numbers are in `wallhack/static/rf-config.json`.

**Direct path (mode `basic`, default).**
`RSSI = tx - PL(d) - sum(wall losses on the straight path) - floors_apart * floor_loss(band)`,
`PL(d) = PL0(band) + 10 * n(band) * log10(max(d, 1 m))`. `PL0` follows free space,
`PL0(f) = 40 + 20 * log10(f / 2.4 GHz)`, using 2.4, 5.5 and 6.5 GHz for the three bands.

**Materials.** Each wall has an optional `material` (drywall, wood, brick, concrete, glass, metal, or a
project-defined one in the twin's `materials`). Without it the kind default applies (interior drywall,
exterior brick), which equals the original 4 dB and 9 dB at 2.4 GHz. A door or window opening replaces the
wall loss where the path crosses it.

**Mode `enhanced`.** Strongest single path of:
1. the direct path;
2. a first-order reflection per wall (image method): mirror the AP across the wall line, require the
   image-to-receiver segment to hit the wall, loss = `PL(total path) + reflection_loss(material) +` losses of
   other walls crossed on both legs, for walls within `max_reflector_range_m`;
3. diffraction around endpoints of walls that block the direct path (knife-edge): `delta = d1 + d2 - d`,
   `v = sqrt(2 * delta / lambda)`, `J(v) = 6.9 + 20 log10(sqrt((v - 0.1)^2 + 1) + v - 0.1)`.

**Mode `multipath`.** Incoherent sum, in mW, of the direct, all reflected and all diffracted paths.
So `multipath >= enhanced >= basic` at every point.

**Where default values come from.** Frequency scaling is free-space physics. Material attenuation and
reflection values are rounded typical figures within the ranges reported by ITU-R P.2040 and published
indoor measurements. They are typical estimates. Real walls vary with thickness, moisture and
reinforcement, so calibrate with a site survey.

**Not modelled.** Fast or slow fading, antenna patterns, polarisation, furniture and people, second-order
reflections, 3D geometry (the plan is 2D; floors add a fixed loss), coherent phase effects.

## Extending
`rfmodel.register_mode(id, fn)` and `RFEngine.registerMode(id, fn)` add a mode;
`RFEngine.registerMaterials(table)` adds materials. See the ADR in `docs/adr-rf-engine.md`.
