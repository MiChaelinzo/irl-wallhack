# 19 Competitive analysis

**Honesty note: written from general knowledge. No competitor page was fetched or re-checked for this document.** Features, prices and positioning change often. Treat every statement about a competitor as "believed, not verified" and re-check before using it in a pitch. Statements about irl-wallhack are checked against the repository.

## Landscape (general knowledge, not freshly researched)

| Product | What it is generally known for | Likely weak points for our audience |
|---|---|---|
| Ekahau (Sidekick, AI Pro) | Professional site surveys with measurement hardware, predictive design, reports | Commercial, high price, desktop tools, hardware dependence for best results |
| Cisco (Meraki dashboard, Catalyst tools, Spaces) | Vendor-integrated planning and monitoring for Cisco gear | Vendor lock-in, account and licence needed, not an open teaching tool |
| Ubiquiti UniFi (design and network tools) | Free-to-use planner for UniFi hardware, simple UI | Vendor-specific hardware catalogue, simplified propagation |
| NetSpot | Survey and heat maps from laptop or phone measurements | Measurement-first, limited predictive modelling, paid tiers |
| Hamina | Cloud network planner with automation | Cloud account, subscription |
| Open source and research tools | Various propagation simulators | Usually no UI polish, no Wi-Fi 7 or SINR in a browser |

## Where irl-wallhack stands (VERIFIED against the repository)

| Capability | irl-wallhack |
|---|---|
| Predictive planner in a browser with no install and no account | Yes (`/planner`, static demo) |
| Offline and local-first, no upload of floor plans | Yes, stated on the page (floor plans are never uploaded; the planner only reads the local twin from the same server) |
| Wi-Fi 4 to 7 rates, SINR, antenna, MLO model | Yes, model estimates (`tests/test_wifi_standards.py`) |
| Measured survey import and calibration | No (NOT BUILT) |
| Real measurement hardware | No (CSI path exists, UNVERIFIED on hardware) |
| Vendor AP catalogue | No |
| Multi-user, cloud, accounts | No |
| Transparent model with formulas and citations, deterministic | Yes (`docs/rf-planner.md`, [15-wifi-physics.md](15-wifi-physics.md)) |
| Recommendations with sensitivity-based confidence | Yes (`rf-optimizer.js`) |
| Combined sensing (presence, breathing) with planning | Yes, simulated by default, real UNVERIFIED |

Honest position: this is a transparent, open, teaching-friendly planner, not a replacement for surveyed professional tools. Without calibration its numbers are planning estimates.

## Proposed innovations (each tied to the repository)

1. **Explainable recommendations**: every suggestion shows its sensitivity (exists) and, once built, a narrated explanation whose numbers are computed by the engine ([06-ai-planner-design.md](06-ai-planner-design.md)).
2. **Survey-calibrated model without hardware**: phone-tapped points feed a fit of the exponent and wall losses (NOT BUILT, [17-ar-computer-vision.md](17-ar-computer-vision.md)).
3. **Teaching mode**: lessons driven by the real engine ([16-educational-mode.md](16-educational-mode.md)).
4. **Planning plus sensing in one digital twin**: coverage next to presence zones, already structurally present.
5. **Privacy by construction**: local-only default, consent notice, off-by-default LLM.

Do not claim parity with surveyed tools. The defensible claims are openness, transparency, offline use and the Wi-Fi 7 and SINR modelling in the browser.
