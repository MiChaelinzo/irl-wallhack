# 10 UI modernisation

## Design system tokens (VERIFIED in `wallhack/static/style.css`)

| Token group | Names | Notes |
|---|---|---|
| Surface | `--bg`, `--card`, `--card-solid`, `--line`, `--glow`, `--glow2` | dark default, glass card |
| Text | `--fg`, `--muted` | |
| Accent | `--accent` (teal), `--accent2` (violet) | |
| Status | `--ok`, `--warn`, `--bad` plus `--ok-bg`, `--bad-bg`, `--idle-bg`, `--warn-bg`, `--info-bg` | |
| Air quality | `--aqi-good` to `--aqi-hazardous` | |
| Layout | `--header-h`, `--header-gap`, `--radius`, `--shadow`, `--ease` | `--header-h` drives sticky-header offsets (FEAT-002) |

Light theme: `:root[data-theme="light"]` overrides the tokens; the planner has a theme button with `aria-pressed`. Dark mode is the default. A user-set theme is stored in localStorage (`planner.js` `THEME_KEY`).

## Contrast, computed from the token values

WCAG relative luminance contrast ratios computed from the hex values in `style.css`. Text threshold for AA is 4.5:1.

| Pair | Ratio | AA text |
|---|---:|---|
| dark `--fg` on `--bg` | 16.75 | pass |
| dark `--muted` on `--bg` | 7.73 | pass |
| dark `--muted` on `--card-solid` | 6.75 | pass |
| dark `--accent` on `--card-solid` | 9.24 | pass |
| dark `--bad` on `--card-solid` | 6.39 | pass |
| dark `--warn` on `--card-solid` | 10.3 | pass |
| light `--fg` on `--bg` | 14.59 | pass |
| light `--muted` on `--bg` | 5.71 | pass |
| light `--muted` on white | 6.22 | pass |
| light `--accent` on white | 5.47 | pass |
| light `--bad` on white | 6.29 | pass |
| light `--warn` on white | 4.92 | pass |
| light `--ok` on white | 5.02 | pass |

Limits of this check: it covers token pairs, not every real foreground and background combination (translucent cards over the glow background change the effective colour, heat-map colours, disabled controls). PARTIALLY VERIFIED.

## WCAG 2.2 AA checklist (honest)

| Criterion | Status | Evidence |
|---|---|---|
| 1.1.1 Non-text content | Partial | canvases have `aria-label` (`planner.html`); the heat map has no text or table equivalent beyond chips and the probe readout |
| 1.3.1 Info and relationships | Partial | headings and `aria-labelledby` sections in `planner.html`; not audited on dashboard pages |
| 1.4.3 Contrast (minimum) | Pass for tokens | table above |
| 1.4.4 Resize text | Partial | body font is `0.9375rem` (was 15px) so the browser text size applies; most sizes in `style.css` are rem; canvas text in the editor is still in px; no 200% zoom walkthrough run |
| 1.4.10 Reflow | Partial | breakpoints at 700, 1100 px in `style.css` (`.planner` collapses to one column); not tested at 320 px |
| 1.4.11 Non-text contrast | Partial | high contrast mode (Contrast button in the planner, `prefers-contrast: more`, `data-contrast="more"`) draws 2 px borders in the text colour; the heat-map colours themselves are not measured |
| 2.1.1 Keyboard | Partial | tool shortcuts (V W A L C H D O S X), arrow-key nudge (Shift for bigger steps), Page Up and Page Down, `?` help in `planner-editor.js`; `tools/a11y_check.py` checks that W selects the wall tool from the focused plan; a full keyboard-only walkthrough by a person was not done |
| 2.4.7 Focus visible | Pass by CSS and check | 3 px `:focus-visible` outlines in `style.css`, `Highlight` under `forced-colors`; `tools/a11y_check.py` checks the Tab target has an outline of at least 2 px |
| 2.4.11 Focus not obscured (WCAG 2.2) | Likely, unverified | sticky header offset via `scroll-padding-top` and `--header-h`; checked visually for compare only |
| 2.5.7 Dragging movements (WCAG 2.2) | Gap | dragging walls and APs on canvas; arrow-key nudging exists for the probe, not shown for every drag |
| 2.5.8 Target size minimum (WCAG 2.2) | Partial | `min-height:40px` for buttons under 700 px width; small `.ap-head button` has `min-height:0` |
| 3.3.x Input errors | Partial | `ProjectError` messages shown in a notice; not audited per field |
| 4.1.2 Name, role, value | Pass in axe | `aria-pressed`, `role="tablist"`, `aria-selected`; axe found `aria-label` on a plain `div` (`#envChips`, now `role="group"`) and floor buttons whose label did not contain the visible text (`#floorUp`, `#floorDown`), both fixed |
| 4.1.3 Status messages | Pass by markup and check | `role="status"` on chips and status line; uncaught errors and rejected promises are shown in `#plannerNotice` or `#note` with `role="alert"` (error boundary in `common.js`), checked by `tools/a11y_check.py` |
| Reduced motion | Pass by CSS | `@media (prefers-reduced-motion: reduce)` blocks in `style.css` |

## Automated check with axe-core (FEAT-005)

`tools/a11y_check.py` (dev only) fetches axe-core from npm into a temporary directory on each run (`npm pack axe-core`), injects it with Playwright `add_script_tag` and runs it in headless Chromium on the live planner, the live dashboard, and the built demo pages `dist/planner.html` and `dist/index.html`. axe-core is not vendored, not committed and not loaded by any page, so the demo CSP is unchanged. Flags: `--dark`, `--light`, `--contrast` (forces high contrast mode).

Before the fixes (axe-core 4.14.1, default theme): one serious violation per page.

| Page | Rule | Impact | Fix |
|---|---|---|---|
| planner | `label-content-name-mismatch` on `#floorUp`, `#floorDown` | serious | `aria-label` now starts with the visible text ("Up, floor above") |
| dashboard | `aria-prohibited-attr` on `#envChips` | serious | `role="group"` so the `aria-label` is allowed |
| dashboard, light theme | `color-contrast` of the SIM ribbons (2.75:1, dark text on `#6d28d9`) | serious | white text in the light theme |
| dashboard, light theme, high contrast | `color-contrast` of healthy status text (4.27:1) | serious | darker `--ok`, `--warn`, `--bad` in light high contrast |
| all pages | `region` (banners outside landmarks: `#privacy`, `#note`, `#plannerNote`, `#demoBanner`) | moderate | banners are labelled `role="region"` |

After the fixes: **0 violations of any impact** on all four pages in the default, dark and light themes, and in dark and light high contrast mode. axe checks only what can be computed from the DOM; by its own documentation that is a part of WCAG, not all of it.

Not checked, so not claimed: screen reader output (NVDA, JAWS, VoiceOver, TalkBack were not run), focus order quality judged by a person, real phones and tablets, touch target sizes on a device, 200% and 400% zoom reflow, Windows high contrast (forced colours) in a real browser, the heat-map colours for colour-vision deficiency beyond choosing viridis and cividis palettes, and the mobile and judge pages (not in the axe run). The honest summary: zero automated violations on the planner and dashboard, not claimed WCAG 2.2 AA conformant.

## Mobile

`@media (max-width:700px)` rules exist, screenshots `docs/screenshot-planner-mobile.png` and `docs/screenshot-mobile.png` come from headless Chromium (PARTIALLY VERIFIED). Touch actions: `#cEdit { touch-action:none }`. Pinch zoom and touch drawing on a real phone are UNVERIFIED (README table).

## Dashboard layouts

The dashboard (`index.html`, 300 lines) is a card grid; the planner is three columns (tools, stage, side panels) collapsing to one column at 1100 px, with a bottom tab strip for analysis panels. A Judge page (`/judge`) and a mobile companion (`/mobile`) exist.

## Proposed modernisation (DESIGN ONLY unless stated)

1. Run axe in the smoke script and fix findings (first, cheapest).
2. Heat-map text alternative: a per-room summary table that updates with the grid.
3. Keyboard drag alternative for walls and APs (move by arrow keys when selected) to meet 2.5.7.
4. Component tokens for spacing and type scale (today spacing is literal px in rules).
5. Keep the no-build, no-CDN approach ([adr-frontend-stack.md](adr-frontend-stack.md)).
