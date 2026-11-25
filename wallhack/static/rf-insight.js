"use strict";
// Wi-Fi architect insight layer: per-room analysis, Gamer Mode, Coverage Score Card, Predictive WiFi Assistant,
// router placement summary, mesh topologies and the WiFi Time Machine.
// These are scoring and presentation layers over rf-engine.js and rf-optimizer.js output. They never change the engine
// result. Every number comes from an engine grid or an engine probe; the mapping to words, grades and ping ranges uses the
// planning assumptions in rf-config.json under "insight" (see its "source" text). No randomness and no clock: the same
// project and options always give the same JSON. Works in the browser (window.RFInsight, after rf-engine.js and
// rf-optimizer.js) and under node.
(function (root) {
  var isNode = typeof module !== "undefined" && module.exports;
  var E = isNode ? require("./rf-engine.js") : root.RFEngine;
  var O = isNode ? require("./rf-optimizer.js") : root.RFOptimizer;
  var round = E.roundTo;
  var COMPASS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"];

  // ---------------------------------------------------------------- small helpers
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  /** 1 at `full`, 0 at `zero`, linear between (either direction, clamped). */
  function component(value, full, zero) { return full === zero ? (value === full ? 1 : 0) : clamp01((value - zero) / (full - zero)); }

  function meanOf(values) {
    return values.length ? values.reduce(function (s, v) { return s + v; }, 0) / values.length : null;
  }

  /** Nearest-rank percentile of an ascending list. */
  function percentile(sorted, p) { return sorted.length ? sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] : null; }

  function ascending(values) { return values.slice().sort(function (a, b) { return a - b; }); }

  function r1(v) { return v === null ? null : round(v, 1); }

  function cloneProject(project) { return JSON.parse(JSON.stringify(project)); }

  /** First entry (list is descending by min_score) whose min_score the score reaches. */
  function pickByScore(list, score) {
    var sorted = list.slice().sort(function (a, b) { return b.min_score - a.min_score; });
    for (var i = 0; i < sorted.length; i++) { if (score >= sorted[i].min_score) { return sorted[i]; } }
    return sorted[sorted.length - 1];
  }

  /** Letter grade of a 0-100 score. kind "gaming" gives A+ to F, kind "card" gives A to F (thresholds: rf-config.json insight). */
  function gradeFor(config, kind, score) {
    var list = kind === "card" ? config.insight.score_card.grades : config.insight.gaming.grades;
    return pickByScore(list, score).grade;
  }

  /** Excellent, Good, Fair or Poor for a 0-100 score. */
  function wordFor(config, score) { return pickByScore(config.insight.rating_words, score).word; }

  function settingsOf(project, opts) {
    var o = opts || {}, config = o.config || (o.env && o.env.config);
    if (!config) { throw new Error("rf-insight needs opts.config or opts.env"); }
    return { config: config, env: o.env || E.makeEnv(config, project.materials), cellM: o.cellM || config.planner.cell_m,
             mode: o.mode || "basic", band: o.band, ispBaseMs: o.ispBaseMs !== undefined ? o.ispBaseMs : config.insight.gaming.isp_base_ms };
  }

  /** Copy of the project where every AP has a WiFi standard, which the engine needs for SINR and reliability. */
  function withStandards(project, config) {
    var copy = cloneProject(project), pc = config.planner;
    copy.floors.forEach(function (f) {
      f.aps.forEach(function (ap) {
        var band = ap.band || pc.default_band;
        if (ap.standard === undefined) { ap.standard = band === "6" ? pc.sinr_default_standard_6ghz : pc.sinr_default_standard; }
      });
    });
    return copy;
  }

  function hopCounter(project) {
    var parent = {};
    project.floors.forEach(function (f) { f.aps.forEach(function (a) { parent[a.id] = a.mesh_parent || null; }); });
    return function (id) {
      var n = 0, cur = id;
      while (parent[cur] && n < 16) { n++; cur = parent[cur]; }
      return n;
    };
  }

  // ---------------------------------------------------------------- engine run with per-cell grids
  /**
   * One engine run for a floor plus flat per-cell grids (row-major) for the layers below. Mesh nodes (ap.mesh_parent) pay the
   * backhaul assumption of the config: throughput x planner_modes.mesh.hop_throughput_factor and + insight.mesh.hop_latency_ms per
   * wireless hop. The engine result itself (res.analytics) is untouched. opts: {config | env, cellM, mode, band}.
   */
  function analyze(project, floorId, opts) {
    var s = settingsOf(project, opts), copy = withStandards(project, s.config);
    var run = E.analyzeFloorWithGrid(copy, floorId, { env: s.env, cellM: s.cellM, mode: s.mode, band: s.band });
    var an = run.analytics, rel = an.sinr ? an.sinr.reliability : null, cols = an.cols, rows = an.rows, total = cols * rows;
    var hops = hopCounter(copy), factor = s.config.planner_modes.mesh.hop_throughput_factor, hopMs = s.config.insight.mesh.hop_latency_ms;
    var g = { rssi: [], served: [], lat: [], thr: [], per: [], loss: [], air: [], sinr: [], hops: [] };
    for (var i = 0; i < total; i++) {
      var r = Math.floor(i / cols), c = i % cols, idx = an.best_ap[r][c];
      g.rssi.push(run.grid.rssi[r][c]);
      var served = !!rel && idx >= 0 && rel.latency_ms[r][c] !== null;
      var h = served ? hops(an.aps[idx].id) : 0;
      g.served.push(served); g.hops.push(h);
      g.lat.push(served ? rel.latency_ms[r][c] + h * hopMs : null);
      g.thr.push(served ? an.sinr.throughput_mbps[r][c] * Math.pow(factor, h) : null);
      g.per.push(served ? rel.per_pct[r][c] : null);
      g.loss.push(served ? rel.loss_pct[r][c] : null);
      g.air.push(served ? rel.airtime_pct[r][c] : null);
      g.sinr.push(served ? an.sinr.sinr_db[r][c] : null);
    }
    return { project: copy, floorId: floorId, env: s.env, config: s.config, cellM: s.cellM, mode: s.mode, band: s.band, ispBaseMs: s.ispBaseMs,
             cols: cols, rows: rows, analytics: an, grids: g };
  }

  // ---------------------------------------------------------------- per-room analysis
  /** Cell indices whose centre lies in the room rectangle (left and top edges inclusive); the room centre cell when none does. */
  function cellsIn(res, room) {
    var out = [];
    for (var r = 0; r < res.rows; r++) {
      for (var c = 0; c < res.cols; c++) {
        var cx = (c + 0.5) * res.cellM, cy = (r + 0.5) * res.cellM;
        if (cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.d) { out.push(r * res.cols + c); }
      }
    }
    if (!out.length) {
      var col = Math.min(res.cols - 1, Math.max(0, Math.floor((room.x + room.w / 2) / res.cellM)));
      var row = Math.min(res.rows - 1, Math.max(0, Math.floor((room.y + room.d / 2) / res.cellM)));
      out.push(row * res.cols + col);
    }
    return out;
  }

  function statsOf(res, room) {
    var cfg = res.config, ic = cfg.insight, g = res.grids, idx = cellsIn(res, room);
    function pick(key, served) { return idx.filter(function (i) { return !served || g.served[i]; }).map(function (i) { return g[key][i]; }); }
    var rssi = pick("rssi", false), served = idx.filter(function (i) { return g.served[i]; });
    var lat = ascending(pick("lat", true)), thr = ascending(pick("thr", true)), n = served.length;
    function m(key, d) { var v = meanOf(pick(key, true)); return v === null ? null : round(v, d); }
    return {
      id: room.id, name: room.name, x: room.x, y: room.y, w: room.w, d: room.d, whole_floor: !!room.whole_floor,
      center: { x: round(room.x + room.w / 2, 2), y: round(room.y + room.d / 2, 2) },
      cells: idx.length, area_m2: round(idx.length * res.cellM * res.cellM, 2), served_cells: n,
      mean_rssi_dbm: round(meanOf(rssi), 1), min_rssi_dbm: round(Math.min.apply(null, rssi), 1),
      coverage_pct: round(100 * rssi.filter(function (v) { return v >= cfg.analytics.coverage_dbm; }).length / idx.length, 1),
      dead_cells: rssi.filter(function (v) { return v < cfg.analytics.dead_zone_dbm; }).length,
      mean_sinr_db: m("sinr", 1), mean_per_pct: m("per", 2), mean_loss_pct: m("loss", 3), mean_latency_ms: m("lat", 1),
      mean_airtime_pct: m("air", 1), mean_throughput_mbps: m("thr", 1),
      latency_range_ms: n ? { low: round(percentile(lat, ic.gaming.range_low_percentile), 2), high: round(percentile(lat, ic.gaming.range_high_percentile), 2) } : null,
      throughput_low_mbps: n ? round(percentile(thr, ic.streaming.throughput_percentile), 1) : null
    };
  }

  /**
   * Engine grids aggregated over each floor.rooms rectangle (cells whose centre lies inside): mean and min RSSI, % of cells at or above
   * analytics.coverage_dbm, mean SINR, packet error, loss, latency, airtime, throughput and the number of dead cells (below
   * analytics.dead_zone_dbm). A floor without rooms gives one whole-floor entry. `result` is an analyze() result (computed when omitted).
   */
  function roomStats(project, floorId, result, opts) {
    var res = result || analyze(project, floorId, opts), floor = E.findFloor(res.project, res.floorId);
    var rooms = floor.rooms && floor.rooms.length ? floor.rooms
      : [{ id: "floor", name: floor.name || "Whole floor", x: 0, y: 0, w: floor.width_m, d: floor.depth_m, whole_floor: true }];
    return rooms.map(function (room) { return statsOf(res, room); });
  }

  // ---------------------------------------------------------------- Gamer Mode and activity scores
  function lossRisk(lossPct, perPct, lr) {
    if (lossPct <= lr.low_max_loss_pct && perPct <= lr.low_max_per_pct) { return "Low"; }
    if (lossPct <= lr.medium_max_loss_pct && perPct <= lr.medium_max_per_pct) { return "Medium"; }
    return "High";
  }

  var GAMING_NOTE = "ESTIMATE: there is no standard formula from RSSI to ping. The range is the ISP base plus the Wi-Fi hop latency from the model (middle half of the room cells), not a measurement.";

  /** Ping range, jitter proxy, loss risk and stability score for one room stats entry. Ping is always a [low, high] range. */
  function gamingOf(st, config, ispBaseMs) {
    var g = config.insight.gaming, share = st.cells ? st.served_cells / st.cells : 0;
    if (!st.served_cells) {
      return { estimate: true, note: GAMING_NOTE, isp_base_ms: ispBaseMs, ping_ms: null, jitter_ms: null, loss_risk: "High", stability_score: 0, grade: "F",
               components: null, reason: "No cell of this room is served by an access point." };
    }
    var lo = ispBaseMs + g.round_trip_factor * st.latency_range_ms.low, hi = ispBaseMs + g.round_trip_factor * st.latency_range_ms.high;
    if (hi - lo < g.min_range_ms) { hi = lo + g.min_range_ms; }
    var jitter = g.round_trip_factor * (st.latency_range_ms.high - st.latency_range_ms.low) + g.airtime_jitter_ms * st.mean_airtime_pct / 100;
    var margin = st.mean_rssi_dbm - config.analytics.coverage_dbm;
    var comp = { ping: component(hi, g.ping_full_ms, g.ping_zero_ms), jitter: component(jitter, g.jitter_full_ms, g.jitter_zero_ms),
                 loss: Math.min(component(st.mean_loss_pct, g.loss_full_pct, g.loss_zero_pct), component(st.mean_per_pct, g.per_full_pct, g.per_zero_pct)),
                 margin: component(margin, g.margin_full_db, g.margin_zero_db) };
    var w = g.weights, score = 100 * share * (w.ping * comp.ping + w.jitter * comp.jitter + w.loss * comp.loss + w.margin * comp.margin);
    score = round(score, 1);
    return { estimate: true, note: GAMING_NOTE, isp_base_ms: ispBaseMs, ping_ms: [round(lo, 1), round(Math.max(hi, round(lo, 1)), 1)], jitter_ms: round(jitter, 1),
             loss_risk: lossRisk(st.mean_loss_pct, st.mean_per_pct, g.loss_risk), stability_score: score, grade: gradeFor(config, "gaming", score),
             components: { ping: round(comp.ping, 3), jitter: round(comp.jitter, 3), loss: round(comp.loss, 3), margin: round(comp.margin, 3), served_share: round(share, 3) } };
  }

  function activity(config, score, extra) {
    var s = round(score, 1);
    return Object.assign({ score: s, word: wordFor(config, s) }, extra);
  }

  function streamingOf(st, config, gaming) {
    var sc = config.insight.streaming, share = st.cells ? st.served_cells / st.cells : 0;
    if (!st.served_cells) { return activity(config, 0, { streams_supported: 0, throughput_mbps: null }); }
    var need = sc.target_streams * sc.stream_mbps, thr = st.throughput_low_mbps;
    var score = 100 * share * Math.min(clamp01(thr / need), gaming.components.loss);
    return activity(config, score, { streams_supported: Math.floor(thr / sc.stream_mbps), throughput_mbps: thr, needs_mbps: need });
  }

  function videoOf(st, config, gaming) {
    var vc = config.insight.video, gc = config.insight.gaming, share = st.cells ? st.served_cells / st.cells : 0;
    if (!st.served_cells) { return activity(config, 0, { throughput_mbps: null }); }
    var comp = { bandwidth: clamp01(st.throughput_low_mbps / vc.min_mbps), latency: component(gaming.ping_ms[1], vc.ping_full_ms, vc.ping_zero_ms),
                 loss: Math.min(component(st.mean_loss_pct, vc.loss_full_pct, vc.loss_zero_pct), component(st.mean_per_pct, gc.per_full_pct, gc.per_zero_pct)) };
    var score = 100 * share * Math.min(comp.bandwidth, comp.latency, comp.loss);
    return activity(config, score, { throughput_mbps: st.throughput_low_mbps, components: { bandwidth: round(comp.bandwidth, 3), latency: round(comp.latency, 3), loss: round(comp.loss, 3) } });
  }

  /** Room stats plus the gaming, streaming and video entries of each room (res from analyze). */
  function assess(res) {
    return roomStats(null, null, res).map(function (st) {
      var gaming = gamingOf(st, res.config, res.ispBaseMs);
      return Object.assign({}, st, { gaming: gaming, streaming: streamingOf(st, res.config, gaming.components ? gaming : { components: { loss: 0 } }),
                                     video: videoOf(st, res.config, gaming.ping_ms ? gaming : { ping_ms: [0, 0] }) });
    });
  }

  /**
   * Gamer Mode: per room estimated ping range (ISP base + Wi-Fi contribution), jitter proxy, packet loss risk (Low, Medium, High),
   * gaming stability score 0-100 and grade A+ to F. opts: {config | env, ispBaseMs (default insight.gaming.isp_base_ms), cellM, mode, band, result}.
   */
  function gamerMode(project, floorId, opts) {
    var res = (opts && opts.result) || analyze(project, floorId, opts);
    return { label: res.config.insight.label, note: GAMING_NOTE, floor: floorId, isp_base_ms: res.ispBaseMs,
             rooms: assess(res).map(function (r) { return Object.assign({ id: r.id, name: r.name, mean_rssi_dbm: r.mean_rssi_dbm, coverage_pct: r.coverage_pct }, r.gaming); }) };
  }

  // ---------------------------------------------------------------- Coverage Score Card
  function weightedScore(rooms, key) {
    var cells = rooms.reduce(function (s, r) { return s + r.cells; }, 0);
    return cells ? rooms.reduce(function (s, r) { return s + r.cells * r[key].score; }, 0) / cells : 0;
  }

  function cardOf(res, rooms) {
    var cfg = res.config, sc = cfg.insight.score_card, w = sc.weights, an = res.analytics;
    var gaming = rooms.length ? rooms.reduce(function (s, r) { return s + r.cells * r.gaming.stability_score; }, 0) / rooms.reduce(function (s, r) { return s + r.cells; }, 0) : 0;
    var streaming = weightedScore(rooms, "streaming"), video = weightedScore(rooms, "video");
    var sinr = an.sinr && an.sinr.mean_sinr_db !== null ? an.sinr.mean_sinr_db : null;
    var comp = { coverage: an.coverage_pct / 100, dead_zones: component(an.dead_zones.length, 0, sc.dead_zone_count_zero),
                 sinr: sinr === null ? 0 : component(sinr, sc.sinr_full_db, sc.sinr_zero_db), activities: (gaming + streaming + video) / 300 };
    var score = round(100 * (w.coverage * comp.coverage + w.dead_zones * comp.dead_zones + w.sinr * comp.sinr + w.activities * comp.activities), 1);
    return { score: score, grade: gradeFor(cfg, "card", score), coverage_pct: an.coverage_pct, dead_zones: an.dead_zones.length,
             dead_zone_area_m2: an.dead_zone_area_m2, mean_sinr_db: sinr,
             components: { coverage: round(comp.coverage, 3), dead_zones: round(comp.dead_zones, 3), sinr: round(comp.sinr, 3), activities: round(comp.activities, 3) },
             ratings: { gaming: { score: round(gaming, 1), word: wordFor(cfg, round(gaming, 1)), grade: gradeFor(cfg, "gaming", round(gaming, 1)) },
                        streaming: { score: round(streaming, 1), word: wordFor(cfg, round(streaming, 1)) },
                        video: { score: round(video, 1), word: wordFor(cfg, round(video, 1)) } } };
  }

  /**
   * Coverage Score Card for a floor: overall grade A to F from coverage %, dead-zone count, mean SINR and the area weighted gaming,
   * streaming and video scores, rating words Excellent/Good/Fair/Poor per activity, and a line per room.
   */
  function scoreCard(project, floorId, opts) {
    var res = (opts && opts.result) || analyze(project, floorId, opts), rooms = assess(res), card = cardOf(res, rooms);
    card.label = res.config.insight.label; card.floor = floorId;
    card.rooms = rooms.map(function (r) {
      return { id: r.id, name: r.name, coverage_pct: r.coverage_pct, ping_ms: r.gaming.ping_ms, gaming_grade: r.gaming.grade, loss_risk: r.gaming.loss_risk,
               streaming: r.streaming.word, video: r.video.word };
    });
    card.text = "Grade " + card.grade + " (" + card.score + " out of 100): coverage " + card.coverage_pct + "%, " + card.dead_zones + " dead zone" + (card.dead_zones === 1 ? "" : "s") +
      ". Gaming " + card.ratings.gaming.word + ", streaming " + card.ratings.streaming.word + ", video calls " + card.ratings.video.word + ". Model estimate.";
    return card;
  }

  // ---------------------------------------------------------------- places and the question parser
  /** Name of the room that contains the point, else the text of the nearest label, else null. */
  function placeName(floor, x, y) {
    var rooms = floor.rooms || [], i;
    for (i = 0; i < rooms.length; i++) {
      if (x >= rooms[i].x && x <= rooms[i].x + rooms[i].w && y >= rooms[i].y && y <= rooms[i].y + rooms[i].d) { return rooms[i].name; }
    }
    var best = null, bestD = Infinity;
    (floor.labels || []).forEach(function (l) {
      var d = Math.hypot(l.x - x, l.y - y);
      if (d < bestD) { bestD = d; best = l.text; }
    });
    return best;
  }

  function tokensOf(text) { return String(text).toLowerCase().replace(/['\u2019]/g, "").split(/[^a-z0-9]+/).filter(Boolean); }

  /** Plural tolerant form of a word: bedrooms -> bedroom, boxes -> box, glass stays glass. */
  function singular(t) {
    if (t.length > 3 && /ies$/.test(t)) { return t.slice(0, -3) + "y"; }
    if (t.length > 3 && /(ch|sh|ss|x)es$/.test(t)) { return t.slice(0, -2); }
    if (t.length > 3 && /s$/.test(t) && !/ss$/.test(t)) { return t.slice(0, -1); }
    return t;
  }

  function normTokens(text) { return tokensOf(text).map(singular); }

  function placesOf(floor, config) {
    var z = config.insight.assistant.label_zone_m, out = [], seen = {};
    (floor.rooms || []).forEach(function (r) {
      var key = normTokens(r.name).join(" ");
      if (!seen[key]) { seen[key] = true; out.push({ kind: "room", id: r.id, name: r.name, tokens: normTokens(r.name), rect: { id: r.id, name: r.name, x: r.x, y: r.y, w: r.w, d: r.d } }); }
    });
    (floor.labels || []).forEach(function (l) {
      var key = normTokens(l.text).join(" ");
      if (!key || seen[key]) { return; }
      seen[key] = true;
      out.push({ kind: "label", id: l.id, name: l.text, tokens: normTokens(l.text), rect: { id: "label:" + l.id, name: l.text, x: l.x - z / 2, y: l.y - z / 2, w: z, d: z } });
    });
    return out;
  }

  function containsRun(hay, needle) {
    if (!needle.length) { return false; }
    for (var i = 0; i + needle.length <= hay.length; i++) {
      var ok = true;
      for (var j = 0; j < needle.length; j++) { if (hay[i + j] !== needle[j]) { ok = false; break; } }
      if (ok) { return true; }
    }
    return false;
  }

  /**
   * Deterministic question parser (rules in docs/rf-planner.md, "Predictive WiFi Assistant"). Lower case, apostrophes removed, words
   * split on non letters or digits, plural endings removed. Place: 1) the full name of a room or label appears as a word run,
   * the longest wins; 2) otherwise the name shares words (not stop words, not numbers) with the question, the most shared words win.
   * Several equal best places give status "ambiguous". Intents and devices are keyword prefixes from insight.assistant.
   */
  function parseQuestion(floor, question, config) {
    var ac = config.insight.assistant, tokens = normTokens(question), padded = " " + tokensOf(question).join(" ") + " ";
    var intents = Object.keys(ac.intents).filter(function (k) {
      return ac.intents[k].some(function (kw) { return padded.indexOf(" " + tokensOf(kw).join(" ")) >= 0; });
    });
    var devices = ac.devices.filter(function (d) { return tokens.indexOf(singular(d)) >= 0; });
    var places = placesOf(floor, config), stop = ac.stopwords.map(singular);
    var exact = places.filter(function (p) { return containsRun(tokens, p.tokens); });
    var best = [], mode = "name";
    if (exact.length) {
      var longest = Math.max.apply(null, exact.map(function (p) { return p.tokens.length; }));
      best = exact.filter(function (p) { return p.tokens.length === longest; });
    } else {
      mode = "words";
      var scored = places.map(function (p) {
        var shared = p.tokens.filter(function (t) { return stop.indexOf(t) < 0 && !/^\d+$/.test(t) && t.length >= 3 && tokens.indexOf(t) >= 0; }).length;
        return { p: p, n: shared };
      }).filter(function (s) { return s.n > 0; });
      if (scored.length) {
        var top = Math.max.apply(null, scored.map(function (s) { return s.n; }));
        best = scored.filter(function (s) { return s.n === top; }).map(function (s) { return s.p; });
      }
    }
    var status = best.length === 1 ? "matched" : best.length > 1 ? "ambiguous" : "unknown";
    return { intents: intents.length ? intents : ["slow"], intents_found: intents, devices: devices, status: status, match_rule: best.length ? mode : null,
             place: best.length === 1 ? best[0] : null, candidates: (best.length > 1 ? best : places).map(function (p) { return { kind: p.kind, id: p.id, name: p.name }; }) };
  }

  // ---------------------------------------------------------------- Predictive WiFi Assistant
  function num(v) { return String(round(v, 1)); }

  function compassOf(dx, dy) {
    var deg = Math.atan2(-dy, dx) * 180 / Math.PI;   // north is the top of the plan (negative y)
    return COMPASS[((Math.round(deg / 45) % 8) + 8) % 8];
  }

  function causeLabel(c) {
    if (c.kind === "wall") { return c.material_label + (c.through === "wall" ? " wall" : " (" + c.through + ")") + ": " + num(c.db) + " dB"; }
    if (c.kind === "floor") { return "Floor or ceiling (" + c.floors + " crossed): " + num(c.db) + " dB"; }
    if (c.kind === "distance") { return "Distance (" + num(c.distance_m) + " m): " + num(c.db) + " dB"; }
    if (c.kind === "interference") { return "Interference (" + c.sources.join(", ") + "): " + num(c.db) + " dB"; }
    return "Busy channel: " + num(c.pct) + "% of the time";
  }

  /** dB ranked causes at one point from the engine probe explain output (walls, floors, distance beyond 1 m, interference as SNR minus SINR). */
  function causesAt(res, probe) {
    var ac = res.config.insight.assistant, ex = probe.explain, list = [];
    ex.walls.forEach(function (w) {
      if (w.loss_db >= ac.min_cause_db) { list.push({ kind: "wall", id: w.wall, material: w.material, material_label: w.material_label, through: w.through, thickness_cm: w.thickness_cm, db: round(w.loss_db, 1) }); }
    });
    if (ex.floor_loss_db >= ac.min_cause_db) { list.push({ kind: "floor", db: round(ex.floor_loss_db, 1), floors: ex.floors_crossed }); }
    var distDb = ex.path_loss_db - res.config.bands[ex.band].pl0_db;
    if (distDb >= ac.min_cause_db) { list.push({ kind: "distance", db: round(distDb, 1), distance_m: ex.distance_m }); }
    if (ex.sinr && ex.sinr.interference.length) {
      var snr = ex.rssi_dbm - ex.sinr.noise_floor_dbm, lost = snr - ex.sinr.sinr_db;
      if (lost >= ac.interference_min_db) {
        var ids = ex.sinr.interference.slice().sort(function (a, b) { return b.power_dbm - a.power_dbm; }).map(function (t) { return t.id; });
        list.push({ kind: "interference", db: round(lost, 1), sources: ids });
      }
    }
    var order = { wall: 0, floor: 1, distance: 2, interference: 3 };
    list.sort(function (a, b) { return (b.db - a.db) || (order[a.kind] - order[b.kind]) || ((a.id || "") < (b.id || "") ? -1 : 1); });
    list.forEach(function (c) { c.text = causeLabel(c); });
    return list;
  }

  function moveCandidates(res, ap, target, ac) {
    var floor = E.findFloor(res.project, res.floorId), out = [];
    if (!floor.aps.some(function (a) { return a.id === ap.id; })) { return out; }
    var dx = target.x - ap.x, dy = target.y - ap.y, dist = Math.hypot(dx, dy), margin = res.config.planner.edge_margin_m;
    if (dist < margin) { return out; }
    ac.move_steps_m.forEach(function (step) {
      var s = Math.min(step, dist);
      var x = Math.min(floor.width_m - margin, Math.max(margin, ap.x + dx * s / dist)), y = Math.min(floor.depth_m - margin, Math.max(margin, ap.y + dy * s / dist));
      out.push({ id: "move:" + ap.id + ":" + step, change: { kind: "move_ap", ap_id: ap.id, x: round(x, 2), y: round(y, 2) },
                 text: "Move " + ap.id + " " + num(s) + " m " + compassOf(dx, dy) + " to (" + round(x, 2) + " m, " + round(y, 2) + " m)" });
    });
    return out;
  }

  function meshCandidates(res, ac) {
    var floor = E.findFloor(res.project, res.floorId);
    var nodes = O.suggestMeshNodes(res.project, res.floorId, { env: res.env, config: res.config, cellM: res.cellM, mode: res.mode }).nodes.slice(0, ac.mesh_candidates);
    return nodes.map(function (n, i) {
      var near = placeName(floor, n.x, n.y);
      return { id: "mesh:" + i, change: { kind: "add_mesh_node", floor: res.floorId, x: n.x, y: n.y, parent_ap_id: n.parent_ap_id },
               text: "Add a mesh node " + (near ? "near " + near + " " : "") + "at (" + n.x + " m, " + n.y + " m)" };
    });
  }

  function roomView(res, rect) {
    var st = statsOf(res, rect), gaming = gamingOf(st, res.config, res.ispBaseMs);
    return { stats: st, gaming: gaming, coverage_pct: st.coverage_pct, score: gaming.stability_score, ping_ms: gaming.ping_ms };
  }

  function measureFix(res, base, cand, rect, opts) {
    var changed = O.applyChange(res.project, cand.change, res.config);
    var after = analyze(changed, res.floorId, { env: res.env, config: res.config, cellM: res.cellM, mode: res.mode, band: res.band, ispBaseMs: res.ispBaseMs });
    var v = roomView(after, rect), b = base;
    var pingChange = v.ping_ms && b.ping_ms ? [round(v.ping_ms[0] - b.ping_ms[0], 1), round(v.ping_ms[1] - b.ping_ms[1], 1)] : null;
    return { id: cand.id, kind: cand.change.kind, change: cand.change, text: cand.text,
             room: { coverage_before_pct: b.coverage_pct, coverage_after_pct: v.coverage_pct, coverage_delta_pts: round(v.coverage_pct - b.coverage_pct, 1),
                     ping_before_ms: b.ping_ms, ping_after_ms: v.ping_ms, ping_change_ms: pingChange, score_before: b.score, score_after: v.score },
             floor: { coverage_before_pct: res.analytics.coverage_pct, coverage_after_pct: after.analytics.coverage_pct,
                      coverage_delta_pts: round(after.analytics.coverage_pct - res.analytics.coverage_pct, 1) } };
  }

  function fixLine(f, roomName) {
    var r = f.room, ping = r.ping_before_ms && r.ping_after_ms ? ", estimated ping " + num(r.ping_before_ms[0]) + " to " + num(r.ping_before_ms[1]) + " ms becomes " +
      num(r.ping_after_ms[0]) + " to " + num(r.ping_after_ms[1]) + " ms" : "";
    return f.text + ": " + roomName + " coverage " + r.coverage_before_pct + "% to " + r.coverage_after_pct + "%" + ping + ", whole floor " + f.floor.coverage_before_pct + "% to " + f.floor.coverage_after_pct + "% (model estimate).";
  }

  /**
   * Answer a plain question such as "Why is my bedroom WiFi slow?" for one floor. Output is structured JSON plus text lines built only
   * from computed numbers. Unknown or ambiguous rooms return status "needs_room" with the list of places to choose from. The diagnosis
   * probes the worst cell of the room (intents dead, drops) or the room centre, ranks causes by dB, and tests each fix with a
   * second engine run (and optimizer whatIf for the confidence). opts: {config | env, cellM, mode, ispBaseMs}.
   */
  function diagnose(project, floorId, question, opts) {
    var res = analyze(project, floorId, opts), cfg = res.config, ac = cfg.insight.assistant, floor = E.findFloor(res.project, floorId);
    var parsed = parseQuestion(floor, question, cfg);
    var base = { label: cfg.insight.label, floor: floorId, question: String(question), intents: parsed.intents, devices: parsed.devices, match_rule: parsed.match_rule };
    if (parsed.status !== "matched") {
      var names = parsed.candidates.map(function (c) { return c.name; });
      return Object.assign(base, { status: "needs_room", rooms: parsed.candidates, causes: [], fixes: [],
        text: [!names.length ? "This floor has no named rooms or labels, so I cannot tell which area you mean."
          : (parsed.status === "ambiguous" ? "Several places match." : "I could not find that room.") + " Which one do you mean? " + names.join(", ") + "."] });
    }
    var place = parsed.place, rect = place.rect, st = statsOf(res, rect), worst = ac.worst_cell_intents.some(function (k) { return parsed.intents.indexOf(k) >= 0; });
    var point = { x: st.center.x, y: st.center.y, which: "centre" };
    if (worst) {
      var cells = cellsIn(res, rect), low = cells[0];
      cells.forEach(function (i) { if (res.grids.rssi[i] < res.grids.rssi[low]) { low = i; } });
      point = { x: round((low % res.cols + 0.5) * res.cellM, 2), y: round((Math.floor(low / res.cols) + 0.5) * res.cellM, 2), which: "worst cell" };
    }
    var probe = E.probeAt(res.project, floorId, point.x, point.y, { env: res.env, mode: res.mode, band: res.band, explain: true });
    var view = roomView(res, rect);
    var out = Object.assign(base, { status: "diagnosed", room: { kind: place.kind, id: place.id, name: place.name }, point: point,
      signal: { rssi_dbm: probe.rssi_dbm, quality: probe.quality, serving_ap: probe.ap_id, distance_m: probe.distance_m, walls_crossed: probe.walls_crossed, floors_crossed: probe.floors_crossed },
      room_stats: view.stats, gaming: view.gaming, causes: [], other_causes: [], primary: null, secondary: null, fixes: [] });
    var text = [];
    if (!probe.ap_id || !probe.explain) {
      out.text = [place.name + ": no access point reaches this point, so there is nothing to diagnose. Add an access point near it (model estimate)."];
      return out;
    }
    out.causes = causesAt(res, probe);
    var apState = res.analytics.sinr ? res.analytics.sinr.aps.filter(function (a) { return a.id === probe.ap_id; })[0] : null;
    if (apState && apState.reliability.channel_busy_pct >= ac.busy_cause_min_pct) {
      out.other_causes.push({ kind: "busy", pct: apState.reliability.channel_busy_pct, ap_id: probe.ap_id, text: "Busy channel: " + num(apState.reliability.channel_busy_pct) + "% of the time" });
    }
    out.primary = out.causes[0] || null;
    out.secondary = out.causes[1] || out.other_causes[0] || null;
    text.push(place.name + " (" + point.which + "): estimated signal " + num(probe.rssi_dbm) + " dBm (" + probe.quality + ") from " + probe.ap_id + ", " + num(probe.distance_m) + " m away through " + probe.walls_crossed + " wall" + (probe.walls_crossed === 1 ? "" : "s") + ".");
    if (view.ping_ms) { text.push("Estimated ping " + num(view.ping_ms[0]) + " to " + num(view.ping_ms[1]) + " ms, packet loss risk " + view.gaming.loss_risk + " (estimate, no standard RSSI to ping formula)."); }
    text.push(out.primary ? "Main cause: " + out.primary.text + "." : "No single cause stands out: every loss term is below " + ac.min_cause_db + " dB.");
    if (out.secondary) { text.push("Second cause: " + out.secondary.text + "."); }
    var cands = [];
    var apHit = res.project.floors.reduce(function (acc, f) { return acc || f.aps.filter(function (a) { return a.id === probe.ap_id; })[0] || null; }, null);
    if (apHit) { cands = cands.concat(moveCandidates(res, apHit, st.center, ac)); }
    cands = cands.concat(meshCandidates(res, ac));
    var tried = cands.map(function (c) { return measureFix(res, view, c, rect); }).filter(function (f) { return f.room.score_after > f.room.score_before || f.room.coverage_delta_pts > 0; });
    tried.sort(function (a, b) {
      return ((b.room.score_after - b.room.score_before) - (a.room.score_after - a.room.score_before)) || (b.room.coverage_delta_pts - a.room.coverage_delta_pts) ||
             (b.floor.coverage_delta_pts - a.floor.coverage_delta_pts) || (a.id < b.id ? -1 : 1);
    });
    out.fixes = tried.slice(0, ac.max_fixes).map(function (f, i) {
      var w = O.whatIf(res.project, floorId, f.change, { env: res.env, config: cfg, cellM: res.cellM, mode: res.mode });
      f.rank = i + 1; f.what_if = { delta: w.delta, confidence: w.confidence, perturbations: w.perturbations, stable_perturbations: w.stable_perturbations };
      f.line = fixLine(f, place.name);
      return f;
    });
    if (!out.fixes.length) { text.push("None of the tested changes (moving " + (apHit ? apHit.id : "the router") + ", adding a mesh node) improves this room in the model."); }
    out.fixes.forEach(function (f) { text.push("Fix " + f.rank + ": " + f.line + " Confidence " + f.what_if.confidence + " (model sensitivity)."); });
    out.text = text;
    return out;
  }

  /** Body for POST /api/planner/explain from a diagnose result: engine numbers and texts only (the server keeps its number guard). */
  function assistantPayload(diagnosis) {
    var d = diagnosis, metrics = [], issues = [];
    if (d.status !== "diagnosed") { return { title: "WiFi question", metrics: [], issues: d.text.slice(), recommendations: [] }; }
    metrics.push({ label: "Signal", value: d.signal.rssi_dbm, unit: "dBm" });
    if (d.primary) { metrics.push({ label: "Main cause loss", value: d.primary.db, unit: "dB" }); issues.push("Main cause: " + d.primary.text); }
    if (d.secondary) { issues.push("Second cause: " + d.secondary.text); }
    if (d.gaming.ping_ms) { metrics.push({ label: "Ping low", value: d.gaming.ping_ms[0], unit: "ms" }, { label: "Ping high", value: d.gaming.ping_ms[1], unit: "ms" }); }
    return { title: "WiFi diagnosis for " + d.room.name, metrics: metrics, issues: issues,
             recommendations: d.fixes.map(function (f) { return { text: f.line, confidence: f.what_if.confidence }; }) };
  }

  // ---------------------------------------------------------------- router placement summary
  function apGridOf(res, floor, ap, apart, apFloor) {
    return E.computeApGrid(floor, ap, { env: res.env, cellM: res.cellM, mode: res.mode, band: res.band, floorsApart: apart, apFloor: apFloor });
  }

  function tally(res, best) {
    var a = res.config.analytics, cov = 0, dead = 0, sum = 0;
    for (var i = 0; i < best.length; i++) { if (best[i] >= a.coverage_dbm) { cov++; } if (best[i] < a.dead_zone_dbm) { dead++; } sum += best[i]; }
    return { covered: cov, dead: dead, mean: sum / best.length };
  }

  /**
   * Best position for the router on a floor, searched over the optimizer candidate lattice with the other access points fixed.
   * Ranking: most cells at or above analytics.coverage_dbm, then fewest dead cells, then highest mean RSSI, then lattice order. The router
   * moves only when that beats its current position. Dead zones removed = dead-zone regions before minus after (a region is a 4-connected
   * group of cells below analytics.dead_zone_dbm, rf-engine.js regionsOf). opts: {apId, config | env, cellM, mode}.
   */
  function placementReport(project, floorId, opts) {
    var res = analyze(project, floorId, opts), cfg = res.config, floor = E.findFloor(res.project, floorId), pc = cfg.planner;
    var onFloor = floor.aps.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    var wanted = opts && opts.apId, router = onFloor.filter(function (a) { return a.id === (wanted || "router"); })[0] || (wanted ? null : onFloor[0]) || null;
    if (wanted && !router) { throw new Error("unknown AP id '" + wanted + "' on floor '" + floorId + "'"); }
    var template = router || { id: "router", tx_dbm: pc.default_tx_dbm, band: res.band || pc.default_band, standard: pc.sinr_default_standard };
    var others = [];
    res.project.floors.forEach(function (f) {
      f.aps.forEach(function (a) { if (a !== router && !(router && a.id === router.id)) { others.push(apGridOf(res, floor, a, Math.abs(f.level - floor.level), f)); } });
    });
    var total = res.cols * res.rows, fixed = new Float64Array(total).fill(cfg.engine.no_signal_dbm);
    others.forEach(function (g) { var flat = [].concat.apply([], g); for (var i = 0; i < total; i++) { if (flat[i] > fixed[i]) { fixed[i] = flat[i]; } } });
    function tallyAt(x, y) {
      var moved = Object.assign({}, template, { x: x, y: y }), flat = [].concat.apply([], apGridOf(res, floor, moved, 0, floor)), best = new Float64Array(total);
      for (var i = 0; i < total; i++) { best[i] = Math.max(fixed[i], flat[i]); }
      return tally(res, best);
    }
    var lattice = O.candidatePositions(res.project, floorId, { env: res.env, config: cfg, cellM: res.cellM, mode: res.mode });
    var current = router ? tallyAt(router.x, router.y) : null, top = null;
    lattice.forEach(function (p) {
      var t = tallyAt(p.x, p.y);
      if (!top || t.covered > top.t.covered || (t.covered === top.t.covered && (t.dead < top.t.dead || (t.dead === top.t.dead && t.mean > top.t.mean)))) { top = { p: p, t: t }; }
    });
    var beats = !current || (top && (top.t.covered > current.covered || (top.t.covered === current.covered && (top.t.dead < current.dead || (top.t.dead === current.dead && top.t.mean > current.mean)))));
    var chosen = beats && top ? { x: round(top.p.x, 2), y: round(top.p.y, 2) } : { x: router.x, y: router.y };
    var out = { label: cfg.insight.label, floor: floorId, ap_id: template.id, had_router: !!router, positions_evaluated: lattice.length + (router ? 1 : 0),
                lattice_positions: lattice.length, moved: !!(beats && top && router), position: chosen, room: placeName(floor, chosen.x, chosen.y),
                current_position: router ? { x: router.x, y: router.y, room: placeName(floor, router.x, router.y) } : null };
    var changed = cloneProject(res.project), target = E.findFloor(changed, floorId);
    if (router) { target.aps.filter(function (a) { return a.id === router.id; }).forEach(function (a) { a.x = chosen.x; a.y = chosen.y; }); }
    else { target.aps.push(Object.assign({}, template, { x: chosen.x, y: chosen.y })); }
    var after = analyze(changed, floorId, { env: res.env, config: cfg, cellM: res.cellM, mode: res.mode, band: res.band });
    var b = res.analytics, a = after.analytics, lb = meanOf(res.grids.lat.filter(function (v) { return v !== null; })), la = meanOf(after.grids.lat.filter(function (v) { return v !== null; }));
    out.coverage_before_pct = b.coverage_pct; out.coverage_after_pct = a.coverage_pct; out.coverage_increase_pts = round(a.coverage_pct - b.coverage_pct, 1);
    out.dead_zones_before = b.dead_zones.length; out.dead_zones_after = a.dead_zones.length; out.dead_zones_removed = b.dead_zones.length - a.dead_zones.length;
    out.dead_cells_removed = round((b.dead_zone_area_m2 - a.dead_zone_area_m2) / (res.cellM * res.cellM), 0);
    out.mean_latency_before_ms = r1(lb); out.mean_latency_after_ms = r1(la); out.latency_change_ms = lb === null || la === null ? null : round(la - lb, 1);
    if (out.moved) {
      var w = O.whatIf(res.project, floorId, { kind: "move_ap", ap_id: router.id, x: chosen.x, y: chosen.y }, { env: res.env, config: cfg, cellM: res.cellM, mode: res.mode });
      out.what_if = { delta: w.delta, confidence: w.confidence };
    }
    if (a.coverage_pct < pc.target_coverage_pct) {
      var extra = O.suggestPlacements(changed, floorId, { env: res.env, config: cfg, cellM: res.cellM, mode: res.mode, count: 1 }).recommendations[0];
      if (extra) { out.additional_ap = { x: extra.x, y: extra.y, room: placeName(floor, extra.x, extra.y), coverage_after_pct: extra.coverage_after_pct }; }
    }
    out.text = (out.moved ? "Best router position: (" + chosen.x + " m, " + chosen.y + " m)" + (out.room ? " in " + out.room : "") : (router ? "The router already sits at the best of the " + out.positions_evaluated + " positions searched: (" + chosen.x + " m, " + chosen.y + " m)" + (out.room ? " in " + out.room : "") : "Best position for a new router: (" + chosen.x + " m, " + chosen.y + " m)")) +
      ". Coverage " + (out.coverage_increase_pts >= 0 ? "+" : "") + out.coverage_increase_pts + " percentage points (" + out.coverage_before_pct + "% to " + out.coverage_after_pct + "%). Dead zones removed " + out.dead_zones_removed +
      ". Mean Wi-Fi latency " + (out.mean_latency_before_ms === null ? "n/a" : out.mean_latency_before_ms + " ms to " + out.mean_latency_after_ms + " ms") + ". " + out.positions_evaluated + " positions evaluated (model estimate).";
    return out;
  }

  // ---------------------------------------------------------------- mesh topologies
  function addNode(project, floorId, node) {
    var copy = cloneProject(project), ids = {}, n = 1;
    copy.floors.forEach(function (f) { f.aps.forEach(function (a) { ids[a.id] = true; }); });
    while (ids["mesh-" + n]) { n++; }
    var target = E.findFloor(copy, floorId);
    target.aps.push({ id: "mesh-" + n, x: node.x, y: node.y, tx_dbm: node.tx_dbm, band: node.band, mesh_parent: node.parent_ap_id });
    return copy;
  }

  function floorMetrics(res, card) {
    var served = function (arr) { return arr.filter(function (v) { return v !== null; }); };
    var lat = meanOf(served(res.grids.lat)), thr = meanOf(served(res.grids.thr));
    return { coverage_pct: res.analytics.coverage_pct, dead_zones: res.analytics.dead_zones.length, mean_latency_ms: r1(lat), mean_throughput_mbps: r1(thr),
             score: card.score, grade: card.grade };
  }

  /**
   * Single router (the project as it is), dual mesh (plus the best mesh node from suggestMeshNodes) and whole-home mesh (nodes up to
   * min(insight.mesh.max_nodes, ceil(rooms / rooms_per_node)), stopping when planner.target_coverage_pct is reached). Coverage and dead
   * zones are engine results; throughput and latency include the wireless backhaul assumption (see analyze). Deltas are against the single router.
   */
  function meshTopologies(project, floorId, opts) {
    var s = settingsOf(project, opts), cfg = s.config, mc = cfg.insight.mesh, floor = E.findFloor(project, floorId);
    var o = { env: s.env, config: cfg, cellM: s.cellM, mode: s.mode, band: s.band, ispBaseMs: s.ispBaseMs };
    var nodeCount = Math.min(mc.max_nodes, Math.max(1, Math.ceil(((floor.rooms || []).length || 1) / mc.rooms_per_node)));
    function nextNode(p) { return O.suggestMeshNodes(p, floorId, o).nodes[0] || null; }
    function build(count, stopAtTarget) {
      var cur = cloneProject(project), nodes = [];
      for (var k = 0; k < count; k++) {
        if (stopAtTarget && analyze(cur, floorId, o).analytics.coverage_pct >= cfg.planner.target_coverage_pct) { break; }
        var n = nextNode(cur);
        if (!n) { break; }
        cur = addNode(cur, floorId, { x: n.x, y: n.y, tx_dbm: n.tx_dbm, band: n.band, parent_ap_id: n.parent_ap_id });
        nodes.push({ x: n.x, y: n.y, parent_ap_id: n.parent_ap_id, backhaul_dbm: n.backhaul_dbm, room: placeName(floor, n.x, n.y) });
      }
      return { project: cur, nodes: nodes };
    }
    var variants = [{ id: "single", label: "Single router (current)", built: { project: project, nodes: [] } },
                    { id: "dual_mesh", label: "Dual mesh (router + 1 node)", built: build(1, false) },
                    { id: "whole_home_mesh", label: "Whole-home mesh (up to " + nodeCount + " nodes)", built: build(nodeCount, true) }];
    var out = variants.map(function (v) {
      var res = analyze(v.built.project, floorId, o), card = cardOf(res, assess(res));
      return Object.assign({ id: v.id, label: v.label, nodes: v.built.nodes }, floorMetrics(res, card));
    });
    out.forEach(function (t) {
      var b = out[0];
      t.delta = { coverage_pts: round(t.coverage_pct - b.coverage_pct, 1), dead_zones: t.dead_zones - b.dead_zones,
                  mean_latency_ms: t.mean_latency_ms === null || b.mean_latency_ms === null ? null : round(t.mean_latency_ms - b.mean_latency_ms, 1),
                  mean_throughput_mbps: t.mean_throughput_mbps === null || b.mean_throughput_mbps === null ? null : round(t.mean_throughput_mbps - b.mean_throughput_mbps, 1), score: round(t.score - b.score, 1) };
    });
    return { label: cfg.insight.label, floor: floorId, assumptions: { hop_throughput_factor: cfg.planner_modes.mesh.hop_throughput_factor, hop_latency_ms: mc.hop_latency_ms,
             note: "Wireless backhaul on a shared band: throughput is multiplied by the factor and latency grows by the hop latency for every hop of a mesh node. Assumptions, not measurements." },
             topologies: out };
  }

  // ---------------------------------------------------------------- WiFi Time Machine
  function stripMesh(project) {
    var copy = cloneProject(project);
    copy.floors.forEach(function (f) { f.aps = f.aps.filter(function (a) { return !a.mesh_parent; }); });
    return copy;
  }

  /** Built-in comparison items (insight.time_machine.presets): every router replaced by an AP class profile, optionally plus one mesh node. */
  function presetItems(project, floorId, opts) {
    var s = settingsOf(project, opts), cfg = s.config, o = { env: s.env, config: cfg, cellM: s.cellM, mode: s.mode, band: s.band };
    return cfg.insight.time_machine.presets.map(function (p) {
      var cur = stripMesh(project), note = "";
      cur.floors.forEach(function (f) { f.aps.slice().forEach(function (a) { cur = O.applyChange(cur, { kind: "upgrade_profile", ap_id: a.id, profile_id: p.profile_id }, cfg); }); });
      if (p.mesh_profile_id) {
        var n = O.suggestMeshNodes(cur, floorId, o).nodes[0];
        if (n) {
          cur = addNode(cur, floorId, { x: n.x, y: n.y, tx_dbm: n.tx_dbm, band: n.band, parent_ap_id: n.parent_ap_id });
          var added = E.findFloor(cur, floorId).aps[E.findFloor(cur, floorId).aps.length - 1];
          cur = O.applyChange(cur, { kind: "upgrade_profile", ap_id: added.id, profile_id: p.mesh_profile_id }, cfg);
          E.findFloor(cur, floorId).aps.forEach(function (a) { if (a.id === added.id) { a.mesh_parent = n.parent_ap_id; } });
        } else { note = "No mesh node position hears the router well enough, so this preset has the router only."; }
      }
      return { id: "preset:" + p.id, label: p.label, project: cur, preset: true, note: note };
    });
  }

  /** The current plan followed by each saved scenario of the project (project.scenarios) as comparison items. */
  function scenarioItems(project) {
    var S = isNode ? require("./planner-state.js") : root.PlannerState;
    var items = [{ id: "current", label: "Current plan", project: project }];
    (project.scenarios || []).forEach(function (sc) { items.push({ id: "scenario:" + sc.id, label: sc.name, project: S.scenarioProject(project, sc) }); });
    return items;
  }

  /**
   * Compare 2 to 4 items ({id, label, project}) on one floor: coverage, dead zones, mean latency, throughput, score card grade. Deltas are
   * against the first item (coverage points, latency percent, dead zones, score, grade change). `ranking` lists ids best score first,
   * ties keep input order. opts: {floorId, config | env, cellM, mode}.
   */
  function timeMachine(items, opts) {
    var o = opts || {}, first = items && items[0];
    if (!first) { throw new Error("timeMachine needs 2 to 4 items"); }
    var s = settingsOf(first.project, o), tm = s.config.insight.time_machine, floorId = o.floorId;
    if (items.length < tm.min_items || items.length > tm.max_items) { throw new Error("timeMachine compares " + tm.min_items + " to " + tm.max_items + " items, got " + items.length); }
    var results = items.map(function (it, i) {
      if (!it.project.floors.some(function (f) { return f.id === floorId; })) { throw new Error("item '" + it.id + "' has no floor '" + floorId + "'"); }
      var res = analyze(it.project, floorId, { env: E.makeEnv(s.config, it.project.materials), config: s.config, cellM: s.cellM, mode: s.mode, band: s.band, ispBaseMs: s.ispBaseMs });
      return Object.assign({ id: it.id, label: it.label, index: i }, floorMetrics(res, cardOf(res, assess(res))), { note: it.note || "" });
    });
    var b = results[0];
    results.forEach(function (r) {
      r.delta = { coverage_pts: round(r.coverage_pct - b.coverage_pct, 1), dead_zones: r.dead_zones - b.dead_zones,
                  mean_latency_pct: b.mean_latency_ms ? round(100 * (r.mean_latency_ms - b.mean_latency_ms) / b.mean_latency_ms, 1) : null,
                  score: round(r.score - b.score, 1), grade_change: b.grade + " to " + r.grade };
    });
    var order = results.slice().sort(function (p, q) { return (q.score - p.score) || (p.index - q.index); });
    order.forEach(function (r, i) { r.rank = i + 1; });
    return { label: s.config.insight.label, floor: floorId, items: results, ranking: order.map(function (r) { return r.id; }) };
  }

  var api = { analyze: analyze, roomStats: roomStats, gamerMode: gamerMode, scoreCard: scoreCard, gradeFor: gradeFor, wordFor: wordFor,
              parseQuestion: parseQuestion, diagnose: diagnose, assistantPayload: assistantPayload, placeName: placeName, placementReport: placementReport,
              meshTopologies: meshTopologies, presetItems: presetItems, scenarioItems: scenarioItems, timeMachine: timeMachine };
  if (isNode) { module.exports = api; }
  root.RFInsight = api;
})(typeof self !== "undefined" ? self : this);
