# ADR: Planner 3D view, in-house WebGL and canvas projection or vendored three.js

Status: accepted. Revisits the three.js option of [adr-frontend-stack.md](adr-frontend-stack.md) with measurements. Decision owner: repository maintainers.

## Context

The planner needs a 3D building view: stacked floors from the elevation model, slabs, basements, an orbit and fly-through camera with keyboard and touch, the heat map on each floor, access point markers, a slicing plane and a signal volume. The frontend has no build step, must run offline on a Raspberry Pi 4, serves under a strict CSP (`script-src 'self'`, no inline scripts, `vercel.json`), has to degrade on weak GPUs and must respect `prefers-reduced-motion`. Repository steering says third-party assets must not be committed unless explicitly approved.

The signal model is 2D per floor plus a floor loss. The volume between floors is therefore interpolated, not simulated. This limit decides how much a general 3D engine can add.

## Options

### A. Vendor three.js (MIT, same-origin file)

- Licence MIT, compatible, the licence header travels inside the minified file. CSP: fine for a same-origin file.
- Cost measured here (three.js r160 `three.module.min.js`, fetched from jsdelivr into a temporary directory, not committed): 670,681 bytes, 166,182 bytes gzip.
- Needs `type="module"` loading or a UMD build. Neither is in the repository today, and the offline Pi install has no package step to fetch it.
- Adds a supply-chain surface and a file that nobody here edits.

### B. Extend the existing in-house code (chosen)

- Pure maths (floor stack, camera, projection, WebGL matrix, slicing, volume interpolation, scene model) in `wallhack/static/planner-3d.js`, run under node in `tests/test_planner_3d.py`.
- A WebGL renderer of about 80 lines (textured quads and lines, no depth test, quads sorted far to near) and a canvas 2D projection renderer used when WebGL is missing or the context is lost. Both draw the same scene model.
- 42,755 bytes, 13,714 bytes gzip, same origin, no new dependency, no licence file to carry.

## Measurements

Environment: headless Chromium in the sandbox, SwiftShader software GL (no real GPU), a 1326 x 796 canvas. A Raspberry Pi 4 was not available, so the Pi figures are UNVERIFIED.

| Item | three.js r160 (benchmark scene) | In-house `planner-3d.js` |
|---|---|---|
| Script size | 670,681 B (166,182 B gzip) | 42,755 B (13,714 B gzip) |
| Script load and evaluate | about 25 ms (dynamic import, two runs: 24.6 and 25.3 ms) | included in page load, no separate import |
| Median WebGL frame, SwiftShader | 12.1 to 12.5 ms | 16.0 ms (p95 17.8 ms) |
| Median canvas projection frame | not applicable | 1.2 ms (p95 1.9 ms) |
| 3D tab open, including floor maps | not measured | 102 ms WebGL, 14 ms canvas |

How these were measured. The in-house numbers come from `tools/perf_3d.py` (large home preset: 8 quads, 88 lines; each frame ends with a one-pixel `readPixels` so the GPU work is counted). The three.js numbers come from a throwaway page that is not in the repository: 8 transparent textured planes of 64 x 40 texels and 90 line segments in one `LineSegments`, 60 frames with a one-pixel `readPixels` after each, same canvas size. The scenes are similar, not identical.

Reading the numbers:

- Frame time is in the same range. On SwiftShader the in-house WebGL path is a few milliseconds slower than three.js (per frame it rebuilds small vertex arrays), and the canvas projection is faster than both here because it draws a coarse 24 x 24 cell grid per layer. None of this predicts Pi 4 GPU behaviour.
- three.js costs 15.7 times the bytes of the in-house file (670,681 B against 42,755 B) for no feature this view uses: no lighting, no shadows, no models, no picking.
- The 3D tab does not open until the user selects it, so the file cost is paid by every page load of the planner either way.

## Decision

Option B. Do not vendor three.js. The view needs textured quads, lines, a camera and sorting, which is small. three.js would add a 670 KB dependency on a Pi class device and a module loading path the project does not have, without improving the measured frame time.

Fallbacks and accessibility, all implemented:

1. WebGL missing, lost or blocked (`?renderer=canvas2d` forces it): the canvas projection draws the same scene, and the chip says "3D renderer: canvas projection".
2. No 2D canvas either: a text description carries the facts (the text region is always present, `role="region"`, `aria-live="polite"`, linked from the canvas with `aria-describedby`).
3. Reduced motion: no animation. The fly-through button becomes "Next viewpoint" and steps through fixed poses. Rendering is on demand, never a free-running loop.
4. Keyboard: arrows orbit, W A S D Q E fly, plus and minus zoom, Home resets. Pointer events cover mouse and touch (one finger orbits, two fingers pinch).

## What the view shows, honestly

- Floors sit at `elevation_m`, or at level times `floor_elevation.reference_height_m`. Basements have negative elevation.
- Each floor carries its own 2D heat map (`coverageGrid`), which already includes the engine floor loss.
- The slicing plane on a floor shows that floor's map. Between floors it shows a blend of the two maps, linear in dB with the height fraction. Above the top floor and below the lowest it shows nothing: nothing is extrapolated.
- The signal volume is a stack of such blended slices. It is interpolated from per-floor 2D results and is NOT a 3D propagation simulation. The label in `rf-config.json` (`planner_3d.label`), the tab text and the text alternative all say so.

## Trade-offs accepted

- No lighting or depth buffer: translucent layers are sorted by centre distance (painter's algorithm), so extreme angles can show a wrong order between two layers.
- Walls and slabs are lines and flat quads, not solids.
- The WebGL path is not optimised (small buffers rebuilt per frame). Profile before changing it.

## Re-open when

- True 3D propagation exists (the 2D model gains a vertical dimension), or the view needs lit solid geometry, picking or model import.
- A Pi 4 measurement shows the in-house renderer misses 30 frames per second on a realistic building (UNVERIFIED today).
- Any reversal needs an explicit approval to commit the vendored file together with its licence text.
