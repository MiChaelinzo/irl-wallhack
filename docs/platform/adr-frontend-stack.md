# ADR: Frontend stack (React, TypeScript, Three.js)

Status: accepted. The three.js part is revisited with measurements in [adr-3d-view.md](adr-3d-view.md), which also keeps it out. Decision owner: repository maintainers. **No rewrite was done.** This record evaluates options and keeps the current stack.

## Context

The browser code is 7,417 lines of vanilla JavaScript in the `wallhack/static/*.js` files (`wc -l`) with no build step. It runs from FastAPI on a Raspberry Pi 4 target, from a static Vercel demo with a strict CSP (`script-src 'self'`, no CDN, `vercel.json`), and under node for tests (the engine is a UMD module, `tests/test_rf_parity.py` runs it from pytest). The 3D view is a hand-written 2D-canvas projection (`wallhack/static/view3d.js`). The heat map uses WebGL directly (`wallhack/static/planner-heat.js`). A JSDoc type check exists for three files (`tsconfig.json`, `make typecheck`).

Pressure for change: a request to evaluate React, TypeScript and Three.js for a "modern platform".

## Criteria

1. Works offline on a Pi with no network at install time.
2. Compatible with the strict CSP and no CDN.
3. Bundle size and load time on a Pi 4.
4. Test cost: the engine must keep running under node and parity tests must not change.
5. Parity: Python stays the source of truth, the JS port must stay a single loadable module.
6. Migration cost and risk against current benefit.
7. Hackathon timeline: visible features beat refactors.

## Options

### A. Keep vanilla JS, add JSDoc `checkJs` coverage (chosen)

- Offline: yes, nothing to install. CSP: yes. Bundle: no bundler, files served as is.
- Test cost: unchanged. Parity: unchanged.
- Type safety: partial and gradual, by widening the `tsconfig.json` `include` list (today `rf-engine.js`, `rf-optimizer.js`, `planner-state.js`). `make typecheck` needs `npx` once (network), so it is a dev-only step.
- Cost: low. Risk: low.
- Weakness: no component model for the UI, `planner-editor.js` is 825 lines.

### B. Vendor Three.js without a build step

- Offline: yes if the file is committed or copied at build time. The repository steering says third-party assets must not be committed unless approved, so it would need explicit approval or a fetch step in `tools/build_demo.py` and `install.sh`, which adds network at install time.
- CSP: fine for a same-origin file. Bundle: Three.js is large (hundreds of KB minified, general knowledge, not measured here) compared with the current hand-written projection.
- Benefit: real lighting, orbit controls, GPU rendering of the building. Today's 3D view works and is tested (`tests/test_view3d.py`).
- Risk: Pi 4 GPU performance unknown (UNVERIFIED), new rendering code to test, no engine benefit because the engine is 2D.
- Verdict: worth it only when true 3D propagation exists. Not now.

### C. Incremental Vite + TypeScript + React behind a build step

- Offline: a node toolchain is needed at build time, which the Pi install flow (`install.sh`, Python only) does not have. Build output could be committed or built in CI, which conflicts with the steering rule against committing large generated artifacts.
- CSP: fine if bundled to same-origin files. Bundle: React adds tens of KB gzipped (general knowledge, not measured here).
- Test cost: the engine would need dual targets (UMD for node tests and Python parity, ESM for the app) or a rewrite of the harness that loads it from pytest.
- Parity: TypeScript can keep the engine as a plain module, but every consumer changes.
- Benefit: components, typed state, easier onboarding. Cost: weeks of work and regression risk in a UI whose behaviour is covered by tests that load the current files by path.
- Verdict: a rewrite with no user-visible gain at hackathon scope.

## Decision

Option A now. Concretely:

1. Keep the no-build vanilla JS architecture. No rewrite was performed in this change set.
2. Widen JSDoc `checkJs` coverage file by file (next: `rf-worker.js`, `planner-export.js`).
3. Re-open the decision when one of these triggers is met: true 3D propagation is built (then evaluate B with a measured Pi frame rate); the UI needs shared component state across more than two pages; or a build step is accepted for other reasons (then evaluate C in a branch with the engine kept as a UMD module).

## Trade-offs accepted

- No component framework: UI code stays imperative. Mitigated by splitting large files along existing seams.
- Partial type checking only.
- The 3D view stays a custom projection with limited visual polish. Mitigated by honest labelling and screenshots.

## Consequences

- Positive: offline install, strict CSP, tests and parity untouched, no new supply chain.
- Negative: slower to build advanced 3D visuals, no React ecosystem.
- Before reversing: measure bundle size and Pi frame rate for any candidate. Neither was measured for this ADR (UNVERIFIED).
