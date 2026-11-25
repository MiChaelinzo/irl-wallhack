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
| Plaster (`plaster`) | medium | 0.41 | 2 / 3 / 5 | 3 / 4 / 7 | 3 / 4.5 / 8 | 12 | 11 | 11 |
| Insulation (`insulation`) | low | 0.41 | 1 / 2 / 4 | 1.5 / 2.5 / 5 | 2 / 3 / 6 | 14 | 13 | 13 |
| Office partition (`office_partition`) | medium | 0.29 | 2 / 3 / 5 | 2.5 / 3.5 / 6 | 3 / 4 / 7 | 13 | 12 | 12 |
| Industrial wall (`industrial_wall`) | low | 0.34 | 8 / 15 / 25 | 10 / 19 / 30 | 11 / 21 / 33 | 5 | 4 | 4 |
| Steel (`steel`) | low | 0.17 | 20 / 32 / 50 | 24 / 36 / 55 | 26 / 38 / 58 | 0.5 | 0.5 | 0.5 |
| Aluminium (`aluminium`) | low | 0.22 | 14 / 24 / 38 | 17 / 28 / 42 | 19 / 30 / 45 | 1 | 1 | 1 |
| Tiles (`tiles`) | low | 0.32 | 5 / 8 / 13 | 6 / 10 / 16 | 7 / 11 / 18 | 6 | 5 | 5 |
| Insulated wall (`insulated_wall`) | low | 0.32 | 5 / 8 / 12 | 6 / 10 / 14 | 7 / 11 / 16 | 5 | 5 | 5 |
| Metal door (`metal_door`) | low | 0.26 | 12 / 20 / 30 | 15 / 24 / 35 | 17 / 26 / 38 | 2 | 2 | 2 |
| Fire door (`fire_door`) | low | 0.31 | 9 / 14 / 22 | 11 / 17 / 26 | 12 / 19 / 28 | 3 | 3 | 3 |
| Flooring (`flooring`) | low | 0.41 | 3 / 6 / 12 | 4 / 8 / 15 | 4 / 9 / 17 | 10 | 9 | 9 |
| Roofing (`roofing`) | low | 0.32 | 4 / 8 / 16 | 5 / 10 / 20 | 6 / 11 / 22 | 9 | 8 | 8 |

## Derived fields

Saved projects store only `attenuation_db` and `reflection_loss_db` per band. The planner and the engines derive the rest (`rfmodel.material_fields`, `RFEngine.materialFields`), nothing extra is stored:

- `attenuation24GHz`, `attenuation5GHz`, `attenuation6GHz`: `attenuation_db` of that band, in dB.
- `penetrationRate`: linear power fraction that passes one crossing, `10^(-attenuation_db / 10)`.
- `reflectionRate`: linear power fraction reflected, `10^(-reflection_loss_db / 10)`.

MODEL ESTIMATE: the rates only restate the typical dB values as fractions, they are not separate measurements. The table shows the rates per band.

| Material | 2.4 GHz penetration | 5 GHz penetration | 6 GHz penetration | 2.4 GHz reflection | 5 GHz reflection | 6 GHz reflection |
|---|---|---|---|---|---|---|
| Glass (`glass`) | 0.5012 | 0.3981 | 0.3548 | 0.1000 | 0.1259 | 0.1259 |
| Drywall (`drywall`) | 0.3981 | 0.3162 | 0.2818 | 0.0631 | 0.0794 | 0.0794 |
| Wood (`wood`) | 0.3162 | 0.2239 | 0.1995 | 0.0794 | 0.1000 | 0.1000 |
| Brick (`brick`) | 0.1259 | 0.0794 | 0.0631 | 0.1585 | 0.1995 | 0.1995 |
| Concrete (`concrete`) | 0.0501 | 0.0200 | 0.0126 | 0.2512 | 0.3162 | 0.3162 |
| Metal (`metal`) | 0.0025 | 0.0010 | 0.0006 | 0.7943 | 0.7943 | 0.7943 |
| Reinforced concrete (`reinforced_concrete`) | 0.0100 | 0.0025 | 0.0013 | 0.3981 | 0.5012 | 0.5012 |
| Stone (`stone`) | 0.0631 | 0.0316 | 0.0200 | 0.1995 | 0.2512 | 0.2512 |
| Plaster (`plaster`) | 0.5012 | 0.3981 | 0.3548 | 0.0631 | 0.0794 | 0.0794 |
| Insulation (`insulation`) | 0.6310 | 0.5623 | 0.5012 | 0.0398 | 0.0501 | 0.0501 |
| Office partition (`office_partition`) | 0.5012 | 0.4467 | 0.3981 | 0.0501 | 0.0631 | 0.0631 |
| Industrial wall (`industrial_wall`) | 0.0316 | 0.0126 | 0.0079 | 0.3162 | 0.3981 | 0.3981 |
| Steel (`steel`) | 0.0006 | 0.0003 | 0.0002 | 0.8913 | 0.8913 | 0.8913 |
| Aluminium (`aluminium`) | 0.0040 | 0.0016 | 0.0010 | 0.7943 | 0.7943 | 0.7943 |
| Tiles (`tiles`) | 0.1585 | 0.1000 | 0.0794 | 0.2512 | 0.3162 | 0.3162 |
| Insulated wall (`insulated_wall`) | 0.1585 | 0.1000 | 0.0794 | 0.3162 | 0.3162 | 0.3162 |
| Metal door (`metal_door`) | 0.0100 | 0.0040 | 0.0025 | 0.6310 | 0.6310 | 0.6310 |
| Fire door (`fire_door`) | 0.0398 | 0.0200 | 0.0126 | 0.5012 | 0.5012 | 0.5012 |
| Flooring (`flooring`) | 0.2512 | 0.1585 | 0.1259 | 0.1000 | 0.1259 | 0.1259 |
| Roofing (`roofing`) | 0.1585 | 0.1000 | 0.0794 | 0.1259 | 0.1585 | 0.1585 |

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

### Plaster (`plaster`)

Plaster or render on lath or thin masonry backing. A wire mesh or metal lath backing raises the loss well above the typical value.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Insulation (`insulation`)

Mineral wool or foam insulation panel without a metal facing. Foil-faced insulation behaves like a thin metal sheet and loses much more, so model it with the metal material.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Office partition (`office_partition`)

Modular office partition of fabric or laminate panels on a light frame, typically 1 to 2 m high screens up to full-height glazed partitions. Full-height steel-framed partitions lose more.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Industrial wall (`industrial_wall`)

Thick concrete block, precast panel or corrugated steel cladding of a factory or warehouse. The range is wide because cladding, racking and stored goods change the loss; use the metal material for a solid steel sheet.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Steel (`steel`)

Structural steel plate, beams and heavy cladding. Effectively a blocker, the measured loss is set by leakage at joints, gaps and openings, not by the steel itself.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Aluminium (`aluminium`)

Aluminium sheet, window frames, curtain wall mullions and foil-backed boards. Thin sheet leaks at edges, so the range is wide.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Tiles (`tiles`)

Ceramic or stone tile on a masonry or board backing, as in bathrooms and kitchens. The tile layer adds a few dB over the bare backing, the backing sets most of the loss.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Insulated wall (`insulated_wall`)

Stud wall with mineral wool or foam insulation and plasterboard on both sides. Foil-faced insulation raises the loss towards the upper end of the range.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Metal door (`metal_door`)

Steel or aluminium skinned door in a frame. Loss is lower than the solid metal wall because of gaps around the leaf, a closed door is assumed.

- Simulation cost: One attenuation lookup per wall crossed in every mode, plus one reflection path per wall in range in enhanced and multipath modes.
- Source: ITU-R P.2040 (effects of building materials and structures on radiowave propagation above about 100 MHz)
- Source: Published indoor measurements and vendor site-survey guides, summarised as rounded typical values

### Fire door (`fire_door`)

Fire-rated door with a steel skin, mineral core and a closed frame. Between a wooden door and a metal door, a closed door is assumed.

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
