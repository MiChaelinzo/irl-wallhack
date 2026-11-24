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

  // ---------------------------------------------------------------- channel plan from SINR
  function cloneProject(project) { return JSON.parse(JSON.stringify(project)); }

  /** Copy of the project where every AP has a WiFi standard (needed for SINR) and the given channels. */
  function withChannels(project, ctx, channels) {
    var copy = cloneProject(project), pc = ctx.pc;
    copy.floors.forEach(function (f) {
      f.aps.forEach(function (ap) {
        var band = ctx.band || ap.band || pc.default_band;
        if (ap.standard === undefined) { ap.standard = band === "6" ? pc.sinr_default_standard_6ghz : pc.sinr_default_standard; }
        if (channels && channels[ap.id] !== undefined) { ap.channel = channels[ap.id]; }
      });
    });
    return copy;
  }

  function meanSinr(copy, floorId, env, ctx) {
    var an = E.analyzeFloor(copy, floorId, { env: env, cellM: ctx.cellM, band: ctx.band || undefined, mode: ctx.mode });
    return an.sinr && an.sinr.mean_sinr_db !== null ? an.sinr.mean_sinr_db : null;
  }

  /**
   * Channel plan that maximises the mean SINR over the floor (co-channel, adjacent-channel and non-WiFi
   * sources included, as computed by rf-engine.js). Coordinate descent: APs in id order, each tries every
   * channel of its band, two passes. Ties keep the current channel. Confidence = share of the wall
   * perturbations (+-dB, +-scale) under which the new plan is at least as good as the old one.
   * APs on other floors are fixed; only APs on this floor change.
   */
  function planChannelsSinr(project, floorId, opts) {
    var ctx = makeContext(project, floorId, opts || {}), pc = ctx.pc;
    var floor = ctx.floor, current = {};
    var base = withChannels(project, ctx, null);
    var aps = E.findFloor(base, floorId).aps;
    aps.forEach(function (ap) {
      var band = ctx.band || ap.band || pc.default_band;
      current[ap.id] = ap.channel !== undefined ? ap.channel : ctx.config.bands[band].default_channel;
    });
    var before = Object.assign({}, current), plan = Object.assign({}, current);
    var best = meanSinr(withChannels(project, ctx, plan), floorId, ctx.env, ctx), startSinr = best;
    for (var pass = 0; pass < pc.channel_sinr_passes && best !== null; pass++) {
      var moved = false;
      aps.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }).forEach(function (ap) {
        var band = ctx.band || ap.band || pc.default_band, keep = plan[ap.id], pick = keep, pickVal = best;
        pc.channel_sets[band].forEach(function (ch) {
          if (ch === keep) { return; }
          var trial = Object.assign({}, plan); trial[ap.id] = ch;
          var v = meanSinr(withChannels(project, ctx, trial), floorId, ctx.env, ctx);
          if (v !== null && v > pickVal) { pick = ch; pickVal = v; }
        });
        if (pick !== keep) { plan[ap.id] = pick; best = pickVal; moved = true; }
      });
      if (!moved) { break; }
    }
    var checks = wallEnvs(ctx).map(function (w) {
      var a = meanSinr(withChannels(project, ctx, before), floorId, w.env, ctx), b = meanSinr(withChannels(project, ctx, plan), floorId, w.env, ctx);
      return a !== null && b !== null && b >= a;
    });
    var stable = checks.filter(Boolean).length, changed = aps.filter(function (ap) { return plan[ap.id] !== before[ap.id]; }).length;
    var conf = changed ? round(Math.min(1, pc.confidence.weight_stability * (stable / checks.length) + pc.confidence.weight_magnitude *
      Math.min(1, ((best || 0) - (startSinr || 0)) / pc.confidence.full_gain_db)), 3) : 1;
    return { label: LABEL, floor: floor.id, objective: "mean SINR over the floor (dB)", sinr_before_db: startSinr === null ? null : round(startSinr, 1),
             sinr_after_db: best === null ? null : round(best, 1), changed: changed, confidence: conf, perturbations: checks.length,
             stable_perturbations: stable,
             assignments: aps.map(function (ap) {
               return { ap_id: ap.id, band: ctx.band || ap.band || pc.default_band, from_channel: before[ap.id], to_channel: plan[ap.id], changed: plan[ap.id] !== before[ap.id] };
             }),
             rationale: startSinr === null ? "SINR is not available for this floor, so no SINR plan was made."
               : changed ? stable + " of " + checks.length + " model perturbations keep the new plan at least as good as the current one. Mean SINR " + round(startSinr, 1) + " dB to " + round(best, 1) + " dB (estimate)."
               : "No channel change improves the mean SINR of " + round(startSinr, 1) + " dB (estimate)." };
  }

  // ---------------------------------------------------------------- mesh node placement
  /**
   * Mesh node candidates: the best placements that still hear an existing AP above the weak backhaul level.
   * Backhaul RSSI comes from the engine probe at the candidate point (walls and floors included).
   */
  function suggestMeshNodes(project, floorId, opts) {
    var o = opts || {}, ctx = makeContext(project, floorId, o), mc = ctx.config.planner_modes.mesh;
    var res = suggestPlacements(project, floorId, Object.assign({}, o, { count: ctx.pc.max_suggestions }));
    var nodes = [], rejected = 0;
    res.recommendations.forEach(function (r) {
      var probe = E.probeAt(project, floorId, r.x, r.y, { env: ctx.env, band: ctx.band || undefined, mode: ctx.mode });
      if (probe.ap_id && probe.rssi_dbm >= mc.weak_backhaul_dbm) {
        nodes.push(Object.assign({}, r, { kind: "mesh_node", parent_ap_id: probe.ap_id, backhaul_dbm: probe.rssi_dbm,
          text: "Add a mesh node at (" + r.x + " m, " + r.y + " m) with " + probe.ap_id + " as uplink: backhaul " + probe.rssi_dbm + " dBm, coverage " +
            r.coverage_before_pct + "% to " + r.coverage_after_pct + "% (estimate)." }));
      } else { rejected++; }
    });
    return { label: LABEL, floor: floorId, weak_backhaul_dbm: mc.weak_backhaul_dbm, nodes: nodes, rejected: rejected,
             note: nodes.length ? "" : !rejected ? "No extra node is needed on this floor." : "No suggested position hears an existing AP above " + mc.weak_backhaul_dbm + " dBm, so a wireless node would have a weak backhaul. Use a cable." };
  }

  // ---------------------------------------------------------------- dead-zone fixes
  /** For each dead zone (largest first): an AP at its centre, with the evaluated gain and confidence. */
  function suggestDeadZoneFixes(project, floorId, opts) {
    var o = opts || {}, ctx = makeContext(project, floorId, o);
    var found = detectIssues(project, floorId, Object.assign({}, o, { env: ctx.env, config: ctx.config })).issues.filter(function (i) { return i.kind === "dead_zone"; });
    found.sort(function (a, b) { return b.area_m2 - a.area_m2; });
    return found.slice(0, ctx.pc.max_dead_zone_fixes).map(function (z) {
      var x = clampToFloor(ctx, z.centroid.x, ctx.floor.width_m), y = clampToFloor(ctx, z.centroid.y, ctx.floor.depth_m);
      var ev = evaluateIn(ctx, x, y, []);
      return Object.assign({ kind: "dead_zone_fix", zone_area_m2: z.area_m2, tx_dbm: ctx.pc.default_tx_dbm, band: ctx.band || ctx.pc.default_band,
        text: "Cover the " + z.area_m2 + " m2 dead zone near (" + ev.x + " m, " + ev.y + " m) with an AP: coverage " + ev.coverage_before_pct + "% to " + ev.coverage_after_pct + "% (estimate)." }, ev);
    });
  }

  // ---------------------------------------------------------------- what-if diff
  /** The numbers a what-if compares, from one floor analytics result. Score is out of 100 (rf-config.json "recommendations"). */
  function metricsOf(an, config) {
    var rc = config.recommendations, w = rc.score_weights;
    // with a WiFi standard on every AP the SINR throughput is used, so interference and channel choices show up in the score
    var speed = an.sinr ? an.sinr.mean_throughput_mbps : an.mean_throughput_mbps;
    var score = 100 * (w.coverage * an.coverage_pct / 100 + w.no_dead_zone * (1 - an.dead_zone_pct / 100) +
                       w.throughput * Math.min(1, speed / rc.throughput_full_mbps));
    return { coverage_pct: an.coverage_pct, dead_zone_pct: an.dead_zone_pct, mean_throughput_mbps: speed,
             client_capacity: an.total_client_capacity, score: round(score, 1), optimiser_score: E.scoreAnalytics(an, config).score };
  }

  /** after minus before for every number of metricsOf (coverage score, dead zone %, average speed, capacity, optimiser score). */
  function diffAnalytics(before, after, config) {
    var a = metricsOf(before, config), b = metricsOf(after, config), delta = {};
    Object.keys(a).forEach(function (k) { delta[k] = round(b[k] - a[k], 2); });
    return { before: a, after: b, delta: delta };
  }

  function findAp(copy, apId) {
    var hit = null;
    copy.floors.forEach(function (f) { f.aps.forEach(function (ap) { if (ap.id === apId) { hit = { ap: ap, floor: f }; } }); });
    if (!hit) { throw new Error("unknown AP id '" + apId + "'"); }
    return hit;
  }

  var CHANGE_KINDS = ["move_ap", "upgrade_profile", "upgrade_standard", "remove_wall", "add_mesh_node", "set_channels"];

  /**
   * A copy of the project with one change applied. Kinds: move_ap {ap_id, x, y}, upgrade_profile {ap_id, profile_id},
   * upgrade_standard {ap_id, standard}, remove_wall {floor, wall_id}, add_mesh_node {floor, x, y, parent_ap_id?, tx_dbm?, band?},
   * set_channels {assignments: [{ap_id, channel}]}. The input is not modified.
   */
  function applyChange(project, change, config) {
    var copy = cloneProject(project), hit;
    if (CHANGE_KINDS.indexOf(change.kind) < 0) { throw new Error("change.kind must be one of " + CHANGE_KINDS.join(", ")); }
    if (change.kind === "move_ap") { hit = findAp(copy, change.ap_id); hit.ap.x = change.x; hit.ap.y = change.y; }
    else if (change.kind === "upgrade_profile") {
      hit = findAp(copy, change.ap_id);
      var next = E.applyApProfile(config, hit.ap, change.profile_id, change.band);
      Object.keys(hit.ap).forEach(function (k) { delete hit.ap[k]; });
      Object.assign(hit.ap, next);
    } else if (change.kind === "upgrade_standard") {
      if (!config.wifi_standards.standards[change.standard]) { throw new Error("unknown standard '" + change.standard + "'"); }
      findAp(copy, change.ap_id).ap.standard = change.standard;
    } else if (change.kind === "remove_wall") {
      var f = E.findFloor(copy, change.floor), n = f.walls.length;
      f.walls = f.walls.filter(function (w) { return w.id !== change.wall_id; });
      if (f.walls.length === n) { throw new Error("unknown wall id '" + change.wall_id + "'"); }
      f.openings = (f.openings || []).filter(function (o) { return o.wall !== change.wall_id; });
    } else if (change.kind === "add_mesh_node") {
      var target = E.findFloor(copy, change.floor), node = { id: "mesh-" + (target.aps.length + 1), x: change.x, y: change.y,
        tx_dbm: change.tx_dbm !== undefined ? change.tx_dbm : config.planner.default_tx_dbm, band: change.band || config.planner.default_band };
      if (change.parent_ap_id) { node.mesh_parent = change.parent_ap_id; }
      target.aps.push(node);
    } else {
      change.assignments.forEach(function (a) { findAp(copy, a.ap_id).ap.channel = a.channel; });
    }
    return copy;
  }

  function runMetrics(ctx, project, env) {
    // every AP gets a WiFi standard first (planner.sinr_default_standard) so before and after are both SINR based
    return E.analyzeFloor(withChannels(project, ctx, null), ctx.floor.id, { env: env, cellM: ctx.cellM, band: ctx.band || undefined, mode: ctx.mode });
  }

  /**
   * Measured before/after of one change on one floor. opts: context options plus `floor` (the floor to measure, default floorId).
   * Returns {change, floor, before, after, delta, confidence, perturbations, stable_perturbations, reason}. Confidence is the share of the
   * wall attenuation perturbations under which the score still improves by at least stability_fraction_of_gain of the nominal gain.
   */
  function whatIf(project, floorId, change, opts) {
    var o = opts || {}, measured = o.floor || floorId, ctx = makeContext(project, measured, o), rc = ctx.config.recommendations;
    var changed = applyChange(project, change, ctx.config);
    var envB = E.makeEnv(ctx.config, changed.materials);
    var nominal = diffAnalytics(runMetrics(ctx, project, ctx.env), runMetrics(ctx, changed, envB), ctx.config);
    var gain = nominal.delta.score, runs = [];
    wallEnvs(ctx).forEach(function (w) {
      runs.push(diffAnalytics(runMetrics(ctx, project, w.env), runMetrics(ctx, changed, w.env), ctx.config).delta.score);
    });
    var stable = gain > 0 ? runs.filter(function (g) { return g >= ctx.pc.confidence.stability_fraction_of_gain * gain; }).length : 0;
    var conf = confidenceOf(ctx, stable, runs.length, gain);
    return { label: rc.label, change: change, floor: measured, before: nominal.before, after: nominal.after, delta: nominal.delta,
             confidence: gain > 0 ? conf.value : 0, perturbations: runs.length, stable_perturbations: stable,
             reason: gain > 0 ? reasonText(ctx, stable, runs.length, "score gain", gain, conf.magnitude) : "The score does not improve, so confidence is 0." };
  }

  // ---------------------------------------------------------------- recommendation engine
  function standardLabel(config, id) { return config.wifi_standards.standards[id].label.replace(/^Wi-Fi /, "WiFi ").replace(/ \(.*\)$/, ""); }

  /** Candidate changes for a floor in a fixed order: moves, standard upgrades, mesh nodes, channel plan. */
  function candidateActions(project, floorId, ctx, o) {
    var rc = ctx.config.recommendations, out = [], floor = ctx.floor, cx = floor.width_m / 2, cy = floor.depth_m / 2;
    floor.aps.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }).forEach(function (ap) {
      var dist = Math.hypot(cx - ap.x, cy - ap.y);
      if (dist >= ctx.pc.edge_margin_m) {
        var step = Math.min(rc.move_step_m, dist);
        out.push({ id: "move:" + ap.id, floor: floorId, text: "Move " + ap.id + " " + round(step, 1) + " m toward the centre",
          change: { kind: "move_ap", ap_id: ap.id, x: round(ap.x + (cx - ap.x) * step / dist, 2), y: round(ap.y + (cy - ap.y) * step / dist, 2) } });
      }
      var nextStd = rc.standard_upgrade[ap.standard === undefined ? (ap.band === "6" ? ctx.pc.sinr_default_standard_6ghz : ctx.pc.sinr_default_standard) : ap.standard];
      if (nextStd && !(ap.band === "6" && nextStd === "wifi6")) {
        out.push({ id: "standard:" + ap.id, floor: floorId, text: "Upgrade " + ap.id + " to " + standardLabel(ctx.config, nextStd),
          change: { kind: "upgrade_standard", ap_id: ap.id, standard: nextStd } });
      }
    });
    project.floors.slice().sort(function (a, b) { return a.level - b.level || (a.id < b.id ? -1 : 1); }).forEach(function (f) {
      var res = suggestMeshNodes(project, f.id, o);
      if (res.nodes.length) {
        var n = res.nodes[0], upstairs = f.level > floor.level;
        out.push({ id: "mesh:" + f.id, floor: f.id, text: "Add mesh node " + (f.id === floorId ? "on " + f.name : upstairs ? "upstairs on " + f.name : "on " + f.name) +
          " at (" + n.x + " m, " + n.y + " m)", change: { kind: "add_mesh_node", floor: f.id, x: n.x, y: n.y, parent_ap_id: n.parent_ap_id } });
      }
    });
    var plan = planChannelsSinr(project, floorId, o);
    var moves = plan.assignments.filter(function (a) { return a.changed; });
    if (moves.length) {
      out.push({ id: "channels", floor: floorId, text: "Reduce interference on channel " + moves[0].from_channel + ": " +
        moves.map(function (a) { return a.ap_id + " to channel " + a.to_channel; }).join(", "),
        change: { kind: "set_channels", assignments: moves.map(function (a) { return { ap_id: a.ap_id, channel: a.to_channel }; }) } });
    }
    return out;
  }

  /**
   * Coverage score out of 100 for the floor and ranked actions. Every action is applied to a copy of the project and measured
   * with whatIf, so its delta is a difference of two model runs, never a guess. Ranked by score delta (then id), actions below
   * recommendations.min_score_gain are dropped. Same project and options always give the same list.
   */
  function recommend(project, floorId, opts) {
    var o = Object.assign({}, opts || {}), ctx = makeContext(project, floorId, o), rc = ctx.config.recommendations;
    o.env = ctx.env; o.config = ctx.config;
    var current = metricsOf(runMetrics(ctx, project, ctx.env), ctx.config);
    var actions = candidateActions(project, floorId, ctx, o).map(function (c) {
      var w = whatIf(project, floorId, c.change, Object.assign({}, o, { floor: c.floor }));
      /** @type {Record<string, any>} */
      var action = { id: c.id, kind: c.change.kind, floor: c.floor, text: c.text, change: c.change, before: w.before, after: w.after, delta: w.delta,
               confidence: w.confidence, perturbations: w.perturbations, stable_perturbations: w.stable_perturbations, reason: w.reason };
      return action;
    }).filter(function (a) { return a.delta.score >= rc.min_score_gain; });
    actions.sort(function (a, b) { return (b.delta.score - a.delta.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    actions = actions.slice(0, rc.max_actions);
    actions.forEach(function (a, i) {
      a.rank = i + 1;
      a.summary = a.text + ": score " + a.before.score + " to " + a.after.score + ", coverage " + a.before.coverage_pct + "% to " + a.after.coverage_pct + "% (estimate).";
    });
    return { label: rc.label, floor: floorId, score: current.score, metrics: current, actions: actions,
             note: actions.length ? "" : "No tested action raises the score by " + rc.min_score_gain + " points or more." };
  }

  // ---------------------------------------------------------------- "Design my network"
  function bearingDeg(fromX, fromY, toX, toY) {
    var deg = Math.atan2(toY - fromY, toX - fromX) * 180 / Math.PI;
    return Math.round(deg < 0 ? deg + 360 : deg);
  }

  /**
   * Deterministic network plan for one floor, ignoring its current APs: AP count and positions from the greedy coverage search,
   * a sector orientation toward the floor centre for APs on the edge when that measurably helps, channels from the conflict graph
   * plan, and a mesh node on every other floor that has no AP. Verified by analysis of the designed project.
   */
  function designNetwork(project, floorId, opts) {
    var o = Object.assign({}, opts || {}), config = o.config || (o.env && o.env.config);
    var base = cloneProject(project), floor = E.findFloor(base, floorId), rc = config.recommendations, pc = config.planner;
    var band = o.band || pc.default_band, target = o.targetPct || pc.target_coverage_pct, maxAps = o.max_aps || rc.design.max_aps;
    floor.aps = [];
    var ctx0 = makeContext(base, floorId, Object.assign({}, o, { config: config, env: o.env || E.makeEnv(config, base.materials) }));
    var before = metricsOf(runMetrics(ctx0, project, ctx0.env), config);
    var res = greedy(ctx0, maxAps, target);
    var cx = floor.width_m / 2, cy = floor.depth_m / 2;
    var aps = res.picks.map(function (p, i) {
      /** @type {Record<string, any>} */
      var ap = { id: "plan-ap" + (i + 1), x: round(p.x, 2), y: round(p.y, 2), tx_dbm: pc.default_tx_dbm, band: band, standard: band === "6" ? pc.sinr_default_standard_6ghz : rc.design.default_standard };
      return ap;
    });
    floor.aps = aps.map(function (a) { return Object.assign({}, a); });
    var po = { config: config, env: ctx0.env, band: o.band, mode: ctx0.mode, cellM: ctx0.cellM };
    var plain = coveragePct(floor, base, floorId, po);
    // orientation: edge APs point at the centre when the sector pattern keeps or raises the coverage
    var edge = pc.edge_margin_m + pc.min_ap_separation_m / 2, orient = [];
    aps.forEach(function (a, i) {
      a.pattern = "omni";
      if (Math.min(a.x, floor.width_m - a.x, a.y, floor.depth_m - a.y) <= edge) {
        var trial = Object.assign({}, floor.aps[i], { pattern: "sector", azimuth_deg: bearingDeg(a.x, a.y, cx, cy) });
        var saved = floor.aps[i]; floor.aps[i] = trial;
        var withSector = coveragePct(floor, base, floorId, po);
        if (withSector >= plain) { a.pattern = "sector"; a.azimuth_deg = trial.azimuth_deg; plain = withSector; orient.push(a.id); } else { floor.aps[i] = saved; }
      }
    });
    var channels = planChannels(base, floorId, po);
    channels.assignments.forEach(function (c) {
      aps.filter(function (a) { return a.id === c.ap_id; }).forEach(function (a) { a.channel = c.to_channel; });
    });
    floor.aps = aps.map(function (a) { return Object.assign({}, a); });
    var mesh = [];
    base.floors.slice().sort(function (a, b) { return a.level - b.level; }).forEach(function (f) {
      if (f.id === floorId || f.aps.length) { return; }
      var found = suggestMeshNodes(base, f.id, po).nodes;
      if (found.length) { mesh.push({ floor: f.id, id: "plan-mesh-" + f.id, x: found[0].x, y: found[0].y, parent_ap_id: found[0].parent_ap_id, backhaul_dbm: found[0].backhaul_dbm, tx_dbm: pc.default_tx_dbm, band: band }); }
    });
    var after = metricsOf(runMetrics(ctx0, base, ctx0.env), config);
    var plan = { label: rc.design.label, floor: floorId, target_pct: target, reached: after.coverage_pct >= target, aps: aps, mesh_nodes: mesh,
                 oriented_aps: orient, channel_conflicts_after: channels.conflicts_after, before: before, after: after,
                 delta: { score: round(after.score - before.score, 2), coverage_pct: round(after.coverage_pct - before.coverage_pct, 2) } };
    plan.text = narratePlan(plan);
    return plan;
  }

  function coveragePct(floor, base, floorId, po) {
    return E.analyzeFloor(base, floorId, { env: po.env, cellM: po.cellM, band: po.band, mode: po.mode }).coverage_pct;
  }

  /** Deterministic plain-language summary of a designNetwork result. Used with the LLM off and when the server is not reachable. */
  function narratePlan(plan) {
    var lines = ["MODEL ESTIMATE, not a measurement. Network plan for floor " + plan.floor + ": " + plan.aps.length + " access points, coverage " +
      plan.before.coverage_pct + "% to " + plan.after.coverage_pct + "% (target " + plan.target_pct + "%" + (plan.reached ? ", reached" : ", not reached") + "), score " +
      plan.before.score + " to " + plan.after.score + " out of 100."];
    plan.aps.forEach(function (a) {
      lines.push(a.id + " at (" + a.x + " m, " + a.y + " m), " + a.band + " GHz channel " + (a.channel === undefined ? "default" : a.channel) +
        (a.pattern === "sector" ? ", sector pointing at " + a.azimuth_deg + " degrees" : ", omni") + ".");
    });
    plan.mesh_nodes.forEach(function (m) { lines.push("Mesh node on floor " + m.floor + " at (" + m.x + " m, " + m.y + " m) with " + m.parent_ap_id + " as uplink, backhaul " + m.backhaul_dbm + " dBm."); });
    return lines.join("\n");
  }

  /** Body for POST /api/planner/explain from a designNetwork result: engine numbers and texts only (the server keeps number grounding). */
  function planPayload(plan) {
    return { title: "Network plan for floor " + plan.floor,
      metrics: [{ label: "Access points", value: plan.aps.length, unit: "" }, { label: "Coverage before", value: plan.before.coverage_pct, unit: "%" },
                { label: "Coverage after", value: plan.after.coverage_pct, unit: "%" }, { label: "Score before", value: plan.before.score, unit: "/100" },
                { label: "Score after", value: plan.after.score, unit: "/100" }, { label: "Mesh nodes", value: plan.mesh_nodes.length, unit: "" }],
      issues: plan.reached ? [] : ["The coverage target of " + plan.target_pct + "% is not reached within the access point limit."],
      recommendations: plan.aps.slice(0, 12).map(function (a) {
        return { text: "Place " + a.id + " at (" + a.x + " m, " + a.y + " m) on channel " + (a.channel === undefined ? "default" : a.channel) + "." };
      }) };
  }

  var api = { detectIssues: detectIssues, suggestPlacements: suggestPlacements, evaluatePlacement: evaluatePlacement,
              recommendApCount: recommendApCount, detectPowerIssues: detectPowerIssues, planChannels: planChannels,
              planChannelsSinr: planChannelsSinr, suggestMeshNodes: suggestMeshNodes, suggestDeadZoneFixes: suggestDeadZoneFixes,
              metricsOf: metricsOf, diffAnalytics: diffAnalytics, applyChange: applyChange, whatIf: whatIf, recommend: recommend,
              designNetwork: designNetwork, narratePlan: narratePlan, planPayload: planPayload };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFOptimizer = api;
})(typeof self !== "undefined" ? self : this);
