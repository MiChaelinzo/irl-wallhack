# Material database

Generated from `wallhack/static/rf-config.json` by `tools/material_doc.py`. Do not edit by hand, a test keeps it in sync.

MODEL ESTIMATE: every figure is a rounded typical value, not a measurement. Calibrate with a site survey.

Attenuation is the loss in dB for one wall crossing. Range is `min / typical / max` in dB. `typical` is the value the engine uses.
Frequency exponent `n` is derived from the typical values as `ln(L6 / L2.4) / ln(f6 / f2.4)`, so loss scales roughly as `f^n`.

| Material | Confidence | Frequency exponent | 2.4 GHz range (dB) | 5 GHz range (dB) | 6 GHz range (dB) | 2.4 GHz reflection (dB) | 5 GHz reflection (dB) | 6 GHz reflection (dB) |
|---|---|---|---|---|---|---|---|---|
| Glass (`glass`) | medium | 0.41 | 2 / 3 / 6 | 3 / 4 / 8 | 3 / 4.5 / 9 | 10 | 9 | 9 |
| Drywall (`drywall`) | medium | 0.32 | 2 / 4 / 6 | 3 / 5 / 8 | 3 / 5.5 / 9 | 12 | 11 | 11 |
| Wood (`wood`) | medium | 0.34 | 3 / 5 / 8 | 4 / 6.5 / 10 | 4 / 7 / 11 | 11 | 10 | 10 |
| Brick (`brick`) | medium | 0.29 | 5 / 9 / 14 | 6 / 11 / 18 | 7 / 12 / 20 | 8 | 7 | 7 |
| Concrete (`concrete`) | medium | 0.38 | 8 / 13 / 20 | 10 / 17 / 28 | 11 / 19 / 32 | 6 | 5 | 5 |
| Metal (`metal`) | low | 0.21 | 15 / 26 / 40 | 18 / 30 / 45 | 20 / 32 / 48 | 1 | 1 | 1 |
| Reinforced concrete (`reinforced_concrete`) | low | 0.37 | 15 / 20 / 32 | 19 / 26 / 40 | 21 / 29 / 45 | 4 | 3 | 3 |
| Stone (`stone`) | low | 0.35 | 8 / 12 / 20 | 10 / 15 / 25 | 11 / 17 / 28 | 7 | 6 | 6 |
| Flooring (`flooring`) | low | 0.41 | 3 / 6 / 12 | 4 / 8 / 15 | 4 / 9 / 17 | 10 | 9 | 9 |
| Roofing (`roofing`) | low | 0.32 | 4 / 8 / 16 | 5 / 10 / 20 | 6 / 11 / 22 | 9 | 8 | 8 |

## Notes, simulation cost and sources

### Glass (`glass`)

Plain single or double glazing. Low-emissivity or metal-coated glass can exceed 20 dB and is not covered, add it as a custom material.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Drywall (`drywall`)

Single or double plasterboard on studs. Insulation or foil backing raises the loss.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Wood (`wood`)

Solid timber or timber stud partitions. Thickness and moisture content change the loss.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Brick (`brick`)

Single-leaf brick or block wall. Plaster, cavities and thickness move the loss within the range.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Concrete (`concrete`)

Plain concrete or dense block wall without dense reinforcement.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Metal (`metal`)

Sheet metal, lift shafts, foil-backed panels. Close to total blockage, the measured loss is set by leakage at gaps and edges.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Reinforced concrete (`reinforced_concrete`)

Concrete with steel reinforcement. The rebar mesh spacing relative to the wavelength dominates and varies a lot, so the range is wide.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Stone (`stone`)

Natural stone masonry. Thickness and porosity vary widely.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Flooring (`flooring`)

Light timber or composite floor build-up. The 2D engine applies floors as a fixed floor_loss_db per floor crossed, this entry is a reference for that value and for a future 3D model. Selecting it for a wall models a thin partition.

- Simulation cost: Same cost as a wall segment if drawn as a wall. The 2D engine has no slab geometry, so this entry is a reference value.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values
- Source: ITU-R P.1238 (indoor propagation, floor penetration loss) for the floor-loss context

### Roofing (`roofing`)

Tiles or sheet over timber, no metal foil. Foil-backed or metal roofing is much higher. The 2D engine has no roof, this entry is a reference for a future 3D model. Selecting it for a wall models a thin partition.

- Simulation cost: Same cost as a wall segment if drawn as a wall. The 2D engine has no slab geometry, so this entry is a reference value.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values
- Source: ITU-R P.1238 (indoor propagation, floor penetration loss) for the floor-loss context

## Floors and roofing

The 2D engine applies floors as a fixed `floor_loss_db` per floor crossed (`rf-config.json`). It has no slab or roof geometry. `flooring` and `roofing` are reference values for that figure and for a future 3D model. They can be picked as a wall material, which then models a thin partition, not a slab.
