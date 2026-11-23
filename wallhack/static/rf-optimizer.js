"use strict";
// Smart WiFi Planner: deterministic issue detection, AP placement, AP count, power and channel advice.
// Everything is a MODEL ESTIMATE built on rf-engine.js. Confidence expresses sensitivity of a
// recommendation to model error, not real-world accuracy (docs/rf-planner.md, "Smart planner").
// All thresholds live in rf-config.json under "planner". No randomness: the same project and
// options always give the same output. Works in the browser (window.RFOptimizer, after rf-engine.js),
// in a Web Worker (importScripts) and under node.
(function (root) {
  var E = (typeof module !== "undefined" && module.exports) ? require("./rf-engine.js") : root.RFEngine;
  var LABEL = "ESTIMATE: planner advice from a propagation model, confidence is model sensitivity, not accuracy";
  var CAND_ID = "candidate";
  var round = E.roundTo;

  // ---------------------------------------------------------------- context
  /** Everything a planner call needs. opts: {config, env, floorId, cellM, band, mode}. */
  function makeContext(project, floorId, opts) {
    var config = opts.config || opts.env.config, pc = config.planner;
    var env = opts.env || E.makeEnv(config, project.materials);
    var floor = E.findFloor(project, floorId);
    var cellM = opts.cellM || pc.cell_m;
    var ax = E.gridAxes(floor, cellM);
    var apList = [];
    project.floors.forEach(function (f) {
      f.aps.forEach(function (ap) { apList.push({ ap: ap, apart: Math.abs(f.level - floor.level), floor: f }); });
    });
    return { project: project, floor: floor, config: config, pc: pc, env: env, cellM: cellM, cols: ax.cols, rows: ax.rows,
             cells: ax.cols * ax.rows, mode: opts.mode || "basic", band: opts.band || null, apList: apList,
             threshold: config.analytics.coverage_dbm };
  }

  function gridFor(ctx, env, ap, apart, apFloor) {
    return E.computeApGrid(ctx.floor, ap, { env: env, cellM: ctx.cellM, mode: ctx.mode, band: ctx.band, floorsApart: apart, apFloor: apFloor });
  }

  function gridsFor(ctx, env, extra) {
    return ctx.apList.concat(extra || []).map(function (e) { return gridFor(ctx, env, e.ap, e.apart, e.floor); });
  }

  function bestOf(ctx, grids) {
    var out = new Float64Array(ctx.cells).fill(ctx.config.engine.no_signal_dbm);
    grids.forEach(function (g) { for (var i = 0; i < out.length; i++) { if (g[i] > out[i]) { out[i] = g[i]; } } });
    return out;
  }

  function coveredCount(ctx, best) {
    var n = 0;
    for (var i = 0; i < best.length; i++) { if (best[i] >= ctx.threshold) { n++; } }
    return n;
  }

  function pctOf(ctx, cells) { return 100 * cells / ctx.cells; }

  function candidateAp(ctx, x, y) {
    return { id: CAND_ID, x: x, y: y, tx_dbm: ctx.pc.default_tx_dbm, band: ctx.band || ctx.pc.default_band };
  }

  // ---------------------------------------------------------------- perturbations (model sensitivity)
  /** Copies of the environment with all wall and opening attenuation changed, one per configured perturbation. */
  function wallEnvs(ctx) {
    var cf = ctx.pc.confidence, out = [];
    /** @type {Array<[string, (v:number)=>number]>} */
    var perturbations = [["wall_plus_db", function (v) { return v + cf.wall_delta_db; }],
     ["wall_minus_db", function (v) { return v - cf.wall_delta_db; }],
     ["wall_scale_up", function (v) { return v * (1 + cf.wall_scale); }],
     ["wall_scale_down", function (v) { return v * (1 - cf.wall_scale); }]];
    perturbations.forEach(function (p) {
      var change = function (att) {
        var next = {};
        Object.keys(att).forEach(function (b) { next[b] = Math.max(0, p[1](att[b])); });
        return next;
      };
      var materials = {}, openings = {};
      Object.keys(ctx.env.materials).forEach(function (k) {
        materials[k] = Object.assign({}, ctx.env.materials[k], { attenuation_db: change(ctx.env.materials[k].attenuation_db) });
      });
      Object.keys(ctx.config.openings).forEach(function (k) {
        openings[k] = Object.assign({}, ctx.config.openings[k], { attenuation_db: change(ctx.config.openings[k].attenuation_db) });
      });
      out.push({ id: p[0], env: { config: Object.assign({}, ctx.config, { openings: openings }), materials: materials } });
    });
    return out;
  }

  function confidenceOf(ctx, stable, total, magnitudePct) {
    var cf = ctx.pc.confidence;
    var stability = total ? stable / total : 0;
    var magnitude = Math.min(1, Math.max(0, magnitudePct / cf.full_gain_pct));
    return { value: round(Math.min(1, cf.weight_stability * stability + cf.weight_magnitude * magnitude), 3),
             stability: round(stability, 3), magnitude: round(magnitude, 3) };
  }

  function reasonText(ctx, stable, total, what, nominalPct, magnitude) {
    var cf = ctx.pc.confidence;
    return stable + " of " + total + " model perturbations keep at least " + Math.round(100 * cf.stability_fraction_of_gain) +
      "% of the nominal " + what + " (" + round(nominalPct, 1) + "%); size of the effect scores " + magnitude +
      ". This is sensitivity to model error, not real-world accuracy.";
  }

  function clampToFloor(ctx, v, hi) { return Math.min(hi - ctx.pc.edge_margin_m, Math.max(ctx.pc.edge_margin_m, v)); }

  /**
   * Coverage gain of adding an AP at (x, y) and how robust it is. Perturbations: the AP moved by
   * shift_m on 4 sides, and all wall attenuation changed by +-wall_delta_db and by +-wall_scale.
   * Confidence = weight_stability * (share of perturbations keeping at least half the nominal gain)
   * + weight_magnitude * min(1, gain / full_gain_pct). Always in [0, 1].
   * `extra` are APs already accepted (list of {ap, apart}).
   */
  function evaluatePlacement(project, floorId, x, y, opts) {
    var ctx = opts.ctx || makeContext(project, floorId, opts);
    return evaluateIn(ctx, x, y, opts.extra || []);
  }

  function evaluateIn(ctx, x, y, extra) {
    var cf = ctx.pc.confidence, cand = candidateAp(ctx, x, y);
    var base = gridsFor(ctx, ctx.env, extra), before = coveredCount(ctx, bestOf(ctx, base));
    var withCand = coveredCount(ctx, bestOf(ctx, base.concat([gridFor(ctx, ctx.env, cand, 0)])));
    var nominal = pctOf(ctx, withCand - before), runs = [];
    wallEnvs(ctx).forEach(function (w) {
      var g = gridsFor(ctx, w.env, extra), b = coveredCount(ctx, bestOf(ctx, g));
      runs.push(pctOf(ctx, coveredCount(ctx, bestOf(ctx, g.concat([gridFor(ctx, w.env, cand, 0)]))) - b));
    });
    [[cf.shift_m, 0], [-cf.shift_m, 0], [0, cf.shift_m], [0, -cf.shift_m]].forEach(function (d) {
      var moved = candidateAp(ctx, clampToFloor(ctx, x + d[0], ctx.floor.width_m), clampToFloor(ctx, y + d[1], ctx.floor.depth_m));
      runs.push(pctOf(ctx, coveredCount(ctx, bestOf(ctx, base.concat([gridFor(ctx, ctx.env, moved, 0)]))) - before));
    });
    var stable = nominal > 0 ? runs.filter(function (g) { return g >= cf.stability_fraction_of_gain * nominal; }).length : 0;
    var conf = confidenceOf(ctx, stable, runs.length, nominal);
    return { x: round(x, 2), y: round(y, 2), gain_pct: round(nominal, 1), coverage_before_pct: round(pctOf(ctx, before), 1),
             coverage_after_pct: round(pctOf(ctx, withCand), 1), confidence: conf.value, perturbations: runs.length,
             stable_perturbations: stable,
             reason: nominal > 0 ? reasonText(ctx, stable, runs.length, "coverage gain", nominal, conf.magnitude)
                                 : "No coverage gain at this position, so confidence is 0." };
  }

  // ---------------------------------------------------------------- placement (greedy)
  function candidateLattice(ctx) {
    var pc = ctx.pc, w = ctx.floor.width_m, d = ctx.floor.depth_m, spacing = pc.candidate_spacing_m, pts;
    do {
      pts = [];
      for (var y = pc.edge_margin_m; y <= d - pc.edge_margin_m + 1e-9; y += spacing) {
        for (var x = pc.edge_margin_m; x <= w - pc.edge_margin_m + 1e-9; x += spacing) { pts.push([x, y]); }
      }
      spacing *= 1.1;
    } while (pts.length > pc.max_candidates);
    return pts;
  }

  /**
   * Greedy maximum-coverage placement over the candidate lattice using cached per-candidate grids.
   * Picks the candidate with the most newly covered cells (ties: larger clipped dB gain, then
   * lattice order) until `limit` APs are added, `targetPct` is reached or the gain is too small.
   */
  function greedy(ctx, limit, targetPct) {
    var pc = ctx.pc, thr = ctx.threshold;
    var best = bestOf(ctx, gridsFor(ctx, ctx.env));
    var placed = ctx.apList.filter(function (e) { return e.apart === 0; }).map(function (e) { return [e.ap.x, e.ap.y]; });
    var cands = candidateLattice(ctx).map(function (p) { return { x: p[0], y: p[1], grid: null }; });
    var curve = [round(pctOf(ctx, coveredCount(ctx, best)), 1)], picks = [];
    while (picks.length < limit && pctOf(ctx, coveredCount(ctx, best)) < targetPct) {
      var top = null;
      for (var k = 0; k < cands.length; k++) {
        var c = cands[k];
        if (placed.some(function (p) { return Math.hypot(p[0] - c.x, p[1] - c.y) < pc.min_ap_separation_m; })) { continue; }
        c.grid = c.grid || gridFor(ctx, ctx.env, candidateAp(ctx, c.x, c.y), 0);
        var cells = 0, clip = 0;
        for (var i = 0; i < best.length; i++) {
          if (c.grid[i] > best[i] && best[i] < thr) {
            if (c.grid[i] >= thr) { cells++; }
            clip += Math.min(c.grid[i], thr) - best[i];
          }
        }
        if (!top || cells > top.cells || (cells === top.cells && clip > top.clip)) { top = { c: c, cells: cells, clip: clip }; }
      }
      if (!top || pctOf(ctx, top.cells) < pc.min_gain_pct) { break; }
      for (var j = 0; j < best.length; j++) { if (top.c.grid[j] > best[j]) { best[j] = top.c.grid[j]; } }
      placed.push([top.c.x, top.c.y]);
      picks.push({ x: top.c.x, y: top.c.y });
      curve.push(round(pctOf(ctx, coveredCount(ctx, best)), 1));
    }
    return { picks: picks, curve: curve };
  }

  function withEvaluations(ctx, picks) {
    var extra = [];
    return picks.map(function (p) {
      var ev = evaluateIn(ctx, p.x, p.y, extra);
      extra = extra.concat([{ ap: candidateAp(ctx, p.x, p.y), apart: 0 }]);
      var pos = "(" + ev.x + " m, " + ev.y + " m)";
      return Object.assign({ kind: "add_ap", tx_dbm: ctx.pc.default_tx_dbm, band: ctx.band || ctx.pc.default_band,
        text: "Add an AP at " + pos + ": coverage " + ev.coverage_before_pct + "% to " + ev.coverage_after_pct + "% (estimate)." }, ev);
    });
  }

  /** Suggested new AP positions, best first. opts: {count, targetPct, ...context options}. */
  function suggestPlacements(project, floorId, opts) {
    var o = opts || {}, ctx = makeContext(project, floorId, o);
    var res = greedy(ctx, o.count || ctx.pc.max_suggestions, o.targetPct || ctx.pc.target_coverage_pct);
    return { label: LABEL, floor: floorId, cell_m: ctx.cellM, coverage_pct: res.curve[0], coverage_after_pct: res.curve[res.curve.length - 1],
             recommendations: withEvaluations(ctx, res.picks) };
  }

  /**
   * Smallest total AP count that reaches `targetPct` coverage, adding to the existing APs, at most
   * `maxAps` in total. Says so when the target is not reachable (best effort).
   */
  function recommendApCount(project, floorId, targetPct, maxAps, opts) {
    var ctx = makeContext(project, floorId, opts || {});
    var existing = ctx.apList.length, res = greedy(ctx, Math.max(0, maxAps - existing), targetPct);
    var coverage = res.curve[res.curve.length - 1], reached = coverage >= targetPct;
    var recs = withEvaluations(ctx, res.picks);
    var curve = res.curve.map(function (c, i) { return { aps: existing + i, coverage_pct: c }; });
    var conf = recs.length ? Math.min.apply(null, recs.map(function (r) { return r.confidence; })) : 1;
    var message = reached
      ? (res.picks.length ? "Estimated " + (existing + res.picks.length) + " APs reach " + targetPct + "% coverage (" + existing +
                            " existing, " + res.picks.length + " new)." : "The existing " + existing + " APs already reach " + targetPct + "% coverage (estimate).")
      : "Best effort: the target of " + targetPct + "% is not reached with " + (existing + res.picks.length) +
        " APs. Estimated coverage is " + coverage + "%" + (existing + res.picks.length >= maxAps ? ", limited by the maximum of " + maxAps + " APs." : ", more APs add too little.");
    return { label: LABEL, target_pct: targetPct, existing_aps: existing, added: res.picks.length, total_aps: existing + res.picks.length,
             reached: reached, coverage_pct: coverage, curve: curve, placements: recs, confidence: conf, message: message };
  }

  // ---------------------------------------------------------------- power advice
  /** Coverage cells and overlap cells when AP `idx` is shifted by `deltaDb`. */
  function powerTrial(ctx, grids, idx, deltaDb) {
    var a = ctx.config.analytics, shifted = grids.map(function (g, k) {
      if (k !== idx || !deltaDb) { return g; }
      var s = new Float64Array(g.length);
      for (var i = 0; i < g.length; i++) { s[i] = g[i] + deltaDb; }
      return s;
    });
    var best = bestOf(ctx, shifted), overlap = 0;
    for (var n = 0; n < ctx.cells; n++) {
      var top = best[n], hits = 0;
      for (var k = 0; k < shifted.length; k++) { if (shifted[k][n] >= a.overlap_min_dbm && shifted[k][n] >= top - a.overlap_margin_db) { hits++; } }
      if (hits >= 2) { overlap++; }
    }
    return { covered: coveredCount(ctx, best), overlap: overlap };
  }

  /**
   * Overpowered APs (lowering tx by power_step_db keeps coverage within tolerance) and underpowered
   * APs (raising tx to max_tx_dbm recovers at least underpowered_min_gain_pct coverage). tx only
   * shifts an AP grid by the same dB, so trials reuse the grids. Perturbations: wall attenuation
   * +-wall_delta_db and +-wall_scale.
   */
  function detectPowerIssues(project, floorId, opts) {
    var ctx = makeContext(project, floorId, opts || {}), pc = ctx.pc, cf = pc.confidence;
    var envs = [{ id: "nominal", env: ctx.env }].concat(wallEnvs(ctx));
    var sets = envs.map(function (e) { return gridsFor(ctx, e.env); });
    var over = [], under = [];
    ctx.apList.forEach(function (entry, idx) {
      var ap = entry.ap, id = ap.id;
      var base = sets.map(function (g) { return powerTrial(ctx, g, idx, 0); });
      var before = pctOf(ctx, base[0].covered);
      if (ap.tx_dbm - pc.power_step_db >= pc.min_tx_dbm) {
        var trials = sets.map(function (g) { return powerTrial(ctx, g, idx, -pc.power_step_db); });
        var drops = trials.map(function (t, k) { return pctOf(ctx, base[k].covered - t.covered); });
        if (drops[0] <= pc.overpowered_tolerance_pct) {
          var stable = drops.slice(1).filter(function (d) { return d <= pc.overpowered_tolerance_pct; }).length;
          var cut = pctOf(ctx, base[0].overlap - trials[0].overlap), conf = confidenceOf(ctx, stable, drops.length - 1, cut);
          over.push({ kind: "overpowered", ap_id: id, from_tx_dbm: ap.tx_dbm, to_tx_dbm: ap.tx_dbm - pc.power_step_db,
            coverage_before_pct: round(before, 1), coverage_after_pct: round(pctOf(ctx, trials[0].covered), 1),
            overlap_reduction_pct: round(cut, 1), confidence: conf.value, perturbations: drops.length - 1,
            text: id + " looks overpowered: lowering tx by " + pc.power_step_db + " dB changes coverage by " + round(drops[0], 1) +
              "% and shrinks the overlapping area by " + round(cut, 1) + " percentage points (negative means it grows) (estimate).",
            reason: reasonText(ctx, stable, drops.length - 1, "unchanged coverage", before, conf.magnitude) });
        }
      }
      if (ap.tx_dbm < pc.max_tx_dbm && before < pc.target_coverage_pct) {
        var up = pc.max_tx_dbm - ap.tx_dbm;
        var gains = sets.map(function (g, k) { return pctOf(ctx, powerTrial(ctx, g, idx, up).covered - base[k].covered); });
        if (gains[0] >= pc.underpowered_min_gain_pct) {
          var ok = gains.slice(1).filter(function (g) { return g >= cf.stability_fraction_of_gain * gains[0]; }).length;
          var after = before + gains[0], c2 = confidenceOf(ctx, ok, gains.length - 1, gains[0]), closes = after >= pc.target_coverage_pct;
          under.push({ kind: "underpowered", ap_id: id, from_tx_dbm: ap.tx_dbm, to_tx_dbm: pc.max_tx_dbm,
            coverage_before_pct: round(before, 1), coverage_after_pct: round(after, 1), closes_deficit: closes,
            fallback: closes ? null : "add_ap", confidence: c2.value, perturbations: gains.length - 1,
            text: id + " looks underpowered: raising tx to " + pc.max_tx_dbm + " dBm lifts coverage from " + round(before, 1) + "% to " +
              round(after, 1) + "% (estimate)" + (closes ? "." : ", which does not close the deficit, so add an AP instead.") +
              " Clients transmit with less power than the AP, so check the uplink.",
            reason: reasonText(ctx, ok, gains.length - 1, "coverage gain", gains[0], c2.magnitude) });
        }
      }
    });
    return { label: LABEL, overpowered: over, underpowered: under };
  }

  // ---------------------------------------------------------------- channel plan
  /**
   * Greedy graph colouring of APs per band over the configured channel set (2.4 GHz: 1, 6, 11).
   * Two APs conflict when either hears the other above the carrier-sense threshold. APs are coloured
   * by decreasing audibility, each taking the channel with the least heard co-channel load.
   */
  function planChannels(project, floorId, opts) {
    var ctx = makeContext(project, floorId, opts || {}), cs = ctx.config.analytics.carrier_sense_dbm;
    var aps = ctx.apList.map(function (e) { return e.ap; });
    var grids = gridsFor(ctx, ctx.env);
    var bandOf = function (ap) { return ctx.band || ap.band || "2.4"; };
    var chanOf = function (ap) { var b = ctx.config.bands[bandOf(ap)]; return ap.channel !== undefined ? ap.channel : b.default_channel; };
    function heard(from, to) {
      var col = Math.min(ctx.cols - 1, Math.max(0, Math.floor(aps[to].x / ctx.cellM)));
      var row = Math.min(ctx.rows - 1, Math.max(0, Math.floor(aps[to].y / ctx.cellM)));
      return grids[from][row * ctx.cols + col];
    }
    var weight = aps.map(function (a, i) {
      return aps.map(function (b, j) {
        if (i === j || bandOf(a) !== bandOf(b)) { return 0; }
        var level = Math.max(heard(i, j), heard(j, i));
        return level >= cs ? level - cs + 1 : 0;
      });
    });
    var conflicts = function (assign) {
      var n = 0;
      for (var i = 0; i < aps.length; i++) { for (var j = i + 1; j < aps.length; j++) { if (weight[i][j] > 0 && assign[i] === assign[j]) { n++; } } }
      return n;
    };
    var before = aps.map(chanOf), after = before.slice(), done = {};
    var order = aps.map(function (_, i) { return i; }).sort(function (p, q) {
      var wp = weight[p].reduce(function (s, v) { return s + v; }, 0), wq = weight[q].reduce(function (s, v) { return s + v; }, 0);
      return (wq - wp) || (p - q);
    });
    order.forEach(function (i) {
      var set = ctx.pc.channel_sets[bandOf(aps[i])], bestCh = null, bestLoad = Infinity;
      set.forEach(function (ch) {
        var load = 0;
        Object.keys(done).forEach(function (j) { if (after[j] === ch) { load += weight[i][j]; } });
        if (load < bestLoad || (load === bestLoad && ch === before[i])) { bestCh = ch; bestLoad = load; }
      });
      after[i] = bestCh; done[i] = true;
    });
    return { label: LABEL, conflicts_before: conflicts(before), conflicts_after: conflicts(after),
             assignments: aps.map(function (ap, i) {
               return { ap_id: ap.id, band: bandOf(ap), from_channel: before[i], to_channel: after[i], changed: before[i] !== after[i] };
             }) };
  }

  // ---------------------------------------------------------------- issue detection
  var SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

  /** Coverage problems of one floor, most severe first. */
  function detectIssues(project, floorId, opts) {
    var o = opts || {}, config = o.config || o.env.config, pc = config.planner;
    var env = o.env || E.makeEnv(config, project.materials);
    var an = E.analyzeFloor(project, floorId, { env: env, cellM: o.cellM || pc.cell_m, band: o.band, mode: o.mode });
    var issues = [];
    an.dead_zones.forEach(function (z) {
      issues.push({ kind: "dead_zone", severity: "high", area_m2: z.area_m2, bbox: z.bbox, centroid: z.centroid,
        text: "Dead zone of " + z.area_m2 + " m2 around (" + z.centroid.x + " m, " + z.centroid.y + " m), below " + config.analytics.dead_zone_dbm + " dBm." });
    });
    if (an.weak_area_pct >= pc.weak_area_issue_pct) {
      issues.push({ kind: "weak_area", severity: "medium", area_m2: an.weak_area_m2,
        text: "Weak coverage on " + an.weak_area_m2 + " m2 (" + an.weak_area_pct + "% of the floor)." });
    }
    an.aps.forEach(function (ap) {
      if (ap.served_cells > 0 && ap.client_capacity < pc.low_capacity_clients) {
        issues.push({ kind: "low_capacity", severity: "medium", ap_id: ap.id, client_capacity: ap.client_capacity,
          text: ap.id + " serves an estimated " + ap.client_capacity + " clients, fewer than " + pc.low_capacity_clients + "." });
      }
      if (ap.channel_utilisation_pct >= pc.high_utilisation_pct) {
        issues.push({ kind: "high_utilisation", severity: ap.saturated ? "high" : "medium", ap_id: ap.id,
          utilisation_pct: ap.channel_utilisation_pct,
          text: ap.id + " channel utilisation is estimated at " + ap.channel_utilisation_pct + "%." });
      }
      ap.cochannel_neighbours.forEach(function (other) {
        if (ap.id < other) {
          issues.push({ kind: "cochannel", severity: "low", ap_id: ap.id, other_ap_id: other, channel: ap.channel,
            text: ap.id + " and " + other + " share channel " + ap.channel + " and hear each other." });
        }
      });
    });
    issues.sort(function (a, b) { return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]; });
    return { label: LABEL, issues: issues, analytics: an };
  }

  var api = { detectIssues: detectIssues, suggestPlacements: suggestPlacements, evaluatePlacement: evaluatePlacement,
              recommendApCount: recommendApCount, detectPowerIssues: detectPowerIssues, planChannels: planChannels };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFOptimizer = api;
})(typeof self !== "undefined" ? self : this);
