"use strict";
// Planner exports: PNG with legend and annotations, CSV (formula-injection safe), project JSON, a hand-built
// PDF coverage report (Helvetica text, JPEG heat map via DCTDecode) and a print fallback. Exporters register
// through PlannerExport.register(id, {label, run(ctx)}); the built-ins below use it too. The pure parts
// (csv, pdf, registry) run under node in tests. MODEL ESTIMATE, not a measurement: every export says so.
(function (root) {
  var ESTIMATE_LINE = "MODEL ESTIMATE, not a measurement";
  var PAGE_W = 595, PAGE_H = 842, MARGIN = 40, LINE_GAP = 1.35;
  var JPEG_QUALITY = 0.85, LEGEND_W = 190, MODE_MAP_PX = 240;
  var FORMULA_START = /^[=+\-@\t\r]/;

  var registry = {}, order = [];
  /** Register an exporter. run(ctx) returns {name, mime, data} (data: string, Uint8Array or Blob) or a promise of it, or null when it acts itself (print). */
  function register(id, exporter) {
    if (!exporter || typeof exporter.run !== "function" || typeof exporter.label !== "string") { throw new Error("exporter '" + id + "' needs a label and a run function"); }
    if (!registry[id]) { order.push(id); }
    registry[id] = exporter;
  }
  function list() { return order.map(function (id) { return { id: id, label: registry[id].label }; }); }
  function get(id) { if (!registry[id]) { throw new Error("no exporter '" + id + "'"); } return registry[id]; }

  // ------------------------------------------------------------------ CSV
  /** One CSV cell. Text starting with = + - @ (or tab, CR) gets an apostrophe prefix so spreadsheets do not run it as a formula; real numbers are written as they are. */
  function csvCell(v) {
    if (v === null || v === undefined) { return ""; }
    var s;
    if (typeof v === "number") { return isFinite(v) ? String(v) : ""; }
    s = String(v);
    if (FORMULA_START.test(s)) { s = "'" + s; }
    return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n"; }

  /** Analytics rows for CSV: label line, summary, quality bands, per-AP table, dead zones. `an` is a worker analytics result. */
  function analyticsRows(an, meta) {
    var rows = [["Wallhack RF analytics", ESTIMATE_LINE], ["Project", meta.project], ["Floor", meta.floor], ["Grid cell (m)", an.cell_m], [],
      ["Summary", "Value", "Unit"],
      ["Coverage", an.coverage_pct, "%"], ["Average RSSI", an.avg_rssi_dbm, "dBm"], ["Weak area", an.weak_area_m2, "m2"], ["Dead zone area", an.dead_zone_area_m2, "m2"],
      ["Dead zones", an.dead_zones.length, "count"], ["Overlap", an.overlap.pct, "%"], ["Roaming zones", an.roaming.pct, "%"],
      ["Mean throughput (ESTIMATE)", an.mean_throughput_mbps, "Mbps"], ["Client capacity (ESTIMATE)", an.total_client_capacity, "clients"], [],
      ["Quality band", "Share of floor (%)"]];
    Object.keys(an.quality_pct).forEach(function (k) { rows.push([k, an.quality_pct[k]]); });
    rows.push([], ["AP", "Band (GHz)", "Channel", "Width (MHz)", "Served area (m2)", "Usable throughput (ESTIMATE, Mbps)", "Client capacity (ESTIMATE)",
                   "Expected clients", "Channel utilisation (ESTIMATE, %)", "Co-channel neighbours"]);
    an.aps.forEach(function (a) { rows.push([a.id, a.band, a.channel, a.width_mhz, a.served_area_m2, a.usable_mbps, a.client_capacity, a.expected_clients, a.channel_utilisation_pct, a.cochannel_neighbours.join(" ")]); });
    if (an.sinr && an.sinr.aps && an.sinr.aps.length) {   // present only when the access points carry a WiFi standard
      rows.push([], ["AP", "Standard", "Mean SINR (ESTIMATE, dB)", "Mean throughput (ESTIMATE, Mbps)", "Served cells", "Interfering APs"]);
      an.sinr.aps.forEach(function (a) { rows.push([a.id, a.standard, a.mean_sinr_db, a.mean_throughput_mbps, a.served_cells, a.interferers.join(" ")]); });
    }
    rows.push([], ["Dead zone", "Area (m2)", "Centre x (m)", "Centre y (m)"]);
    an.dead_zones.forEach(function (z, i) { rows.push([i + 1, z.area_m2, z.centroid.x, z.centroid.y]); });
    return rows;
  }

  // ------------------------------------------------------------------ PDF
  function winAnsi(s) {
    return String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "\"").replace(/[\u2013\u2014]/g, "-")
      .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  }
  function pdfText(s) { return "(" + winAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")"; }
  function num(v) { return (Math.round(v * 100) / 100).toString(); }
  function latin1(s) { var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) { b[i] = s.charCodeAt(i) & 255; } return b; }

  /** Minimal PDF 1.4 writer: pages with text, lines, rectangles and DCT (JPEG) images. build() returns a Uint8Array. */
  function createPdf() {
    var pages = [], images = [], cur = null;
    var doc = {
      addPage: function () { cur = { ops: [], images: [] }; pages.push(cur); return pages.length; },
      text: function (x, y, size, str, bold) { cur.ops.push("BT /" + (bold ? "F2" : "F1") + " " + num(size) + " Tf " + num(x) + " " + num(PAGE_H - y) + " Td " + pdfText(str) + " Tj ET"); },
      line: function (x1, y1, x2, y2, width) { cur.ops.push(num(width || 0.5) + " w " + num(x1) + " " + num(PAGE_H - y1) + " m " + num(x2) + " " + num(PAGE_H - y2) + " l S"); },
      rect: function (x, y, w, h, gray) { cur.ops.push(num(gray) + " g " + num(x) + " " + num(PAGE_H - y - h) + " " + num(w) + " " + num(h) + " re f 0 g"); },
      /** JPEG bytes with its pixel size, drawn into the box (x, y top-left, w by h points). */
      image: function (jpeg, pxW, pxH, x, y, w, h) {
        var idx = images.push({ bytes: jpeg, w: pxW, h: pxH }) - 1;
        cur.images.push(idx);
        cur.ops.push("q " + num(w) + " 0 0 " + num(h) + " " + num(x) + " " + num(PAGE_H - y - h) + " cm /Im" + idx + " Do Q");
      },
      build: function () {
        var objs = [];   // index n holds object n + 1: array of strings / Uint8Array parts
        function add(parts) { objs.push(parts); return objs.length; }
        var catalog = add([]), pagesObj = add([]), f1 = add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]),
            f2 = add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]);
        var imageIds = images.map(function (im) {
          return add(["<< /Type /XObject /Subtype /Image /Width " + im.w + " /Height " + im.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + im.bytes.length + " >>\nstream\n", im.bytes, "\nendstream"]);
        });
        var kids = pages.map(function (pg) {
          var content = pg.ops.join("\n"), cid = add(["<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream"]);
          var xo = pg.images.map(function (i) { return "/Im" + i + " " + imageIds[i] + " 0 R"; }).join(" ");
          return add(["<< /Type /Page /Parent " + pagesObj + " 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H + "] /Contents " + cid + " 0 R /Resources << /Font << /F1 " + f1 + " 0 R /F2 " + f2 + " 0 R >>" + (xo ? " /XObject << " + xo + " >>" : "") + " >> >>"]);
        });
        objs[catalog - 1] = ["<< /Type /Catalog /Pages " + pagesObj + " 0 R >>"];
        objs[pagesObj - 1] = ["<< /Type /Pages /Kids [" + kids.map(function (k) { return k + " 0 R"; }).join(" ") + "] /Count " + kids.length + " >>"];
        var chunks = [], offset = 0, offsets = [];
        function push(p) { var b = typeof p === "string" ? latin1(p) : p; chunks.push(b); offset += b.length; }
        push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
        objs.forEach(function (parts, i) { offsets.push(offset); push((i + 1) + " 0 obj\n"); parts.forEach(push); push("\nendobj\n"); });
        var xref = offset, x = "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
        offsets.forEach(function (o) { x += ("0000000000" + o).slice(-10) + " 00000 n \n"; });
        push(x + "trailer\n<< /Size " + (objs.length + 1) + " /Root " + catalog + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
        var out = new Uint8Array(offset), at = 0;
        chunks.forEach(function (c) { out.set(c, at); at += c.length; });
        return out;
      }
    };
    return doc;
  }

  /** Greedy word wrap using an average Helvetica glyph width of 0.5 em. */
  function wrapText(str, size, widthPt) {
    var max = Math.max(8, Math.floor(widthPt / (size * 0.5))), words = String(str).split(/\s+/), lines = [], line = "";
    words.forEach(function (w) {
      if ((line + " " + w).trim().length > max && line) { lines.push(line); line = w; } else { line = (line + " " + w).trim(); }
    });
    if (line) { lines.push(line); }
    return lines;
  }

  /**
   * Coverage report. data: {title, project, floor, date, summary: [[label, value]], aps: [header + rows],
   * issues: [text], recommendations: [text], image: {bytes, w, h} or null}. Optional sections, each skipped when absent:
   * floors, ap_locations, spectrum, performance (header + rows), mode_maps [{label, coverage_pct, image}], accessible_text (text).
   */
  function buildReport(data) {
    var pdf = createPdf(), y = 0, width = PAGE_W - 2 * MARGIN;
    function footer() {
      pdf.line(MARGIN, PAGE_H - 44, PAGE_W - MARGIN, PAGE_H - 44, 0.4);
      pdf.text(MARGIN, PAGE_H - 30, 8, ESTIMATE_LINE + ". Values come from a propagation model with typical material losses. Throughput, capacity and utilisation are estimates. Verify with a site survey.");
    }
    function newPage() { pdf.addPage(); footer(); y = MARGIN + 10; }
    function ensure(h) { if (y + h > PAGE_H - 60) { newPage(); } }
    function heading(t) { ensure(30); y += 8; pdf.text(MARGIN, y + 12, 13, t, true); y += 22; }
    function para(t, size) {
      wrapText(t, size, width).forEach(function (l) { ensure(size * LINE_GAP); pdf.text(MARGIN, y + size, size, l); y += size * LINE_GAP; });
    }
    function tableOut(rows, colX) {
      rows.forEach(function (r, i) {
        ensure(14);
        r.forEach(function (c, k) { pdf.text(MARGIN + colX[k], y + 9, 9, String(c).slice(0, Math.floor(((colX[k + 1] || width) - colX[k]) / 4.6)), i === 0); });
        y += 13;
      });
    }
    newPage();
    pdf.text(MARGIN, y + 18, 20, data.title, true); y += 30;
    para("Project: " + data.project + "   Floor: " + data.floor + "   Date: " + data.date, 10);
    pdf.rect(MARGIN, y + 4, width, 22, 0.9); pdf.text(MARGIN + 8, y + 19, 11, ESTIMATE_LINE + ". Not a site survey.", true); y += 34;
    heading("Summary");
    tableOut(data.summary, [0, 230]);
    if (data.floors && data.floors.length) { heading("Floor overview (" + ESTIMATE_LINE + ")"); tableOut(data.floors, [0, 150, 200, 260, 360, 450]); }
    if (data.image) {
      var h = Math.min(300, width * data.image.h / data.image.w), w = h * data.image.w / data.image.h;
      ensure(h + 30); heading("Heat map (" + ESTIMATE_LINE + ")");
      pdf.image(data.image.bytes, data.image.w, data.image.h, MARGIN, y, w, h); y += h + 6;
    }
    if (data.mode_maps && data.mode_maps.length) {
      heading("Coverage maps per propagation mode (" + ESTIMATE_LINE + ")");
      data.mode_maps.forEach(function (m) {
        var mh = Math.min(150, width * m.image.h / m.image.w), mw = mh * m.image.w / m.image.h;
        ensure(mh + 24); pdf.text(MARGIN, y + 10, 10, m.label + ": coverage " + m.coverage_pct + " % (estimate)", true); y += 16;
        pdf.image(m.image.bytes, m.image.w, m.image.h, MARGIN, y, mw, mh); y += mh + 6;
      });
    }
    heading("Access points");
    tableOut(data.aps, [0, 60, 130, 200, 270, 350, 430]);
    if (data.ap_locations && data.ap_locations.length > 1) { heading("Access point locations"); tableOut(data.ap_locations, [0, 90, 190, 260, 330, 400]); }
    if (data.spectrum && data.spectrum.length > 1) { heading("Spectrum summary (" + ESTIMATE_LINE + ")"); tableOut(data.spectrum, [0, 80, 130, 200, 280]); }
    if (data.performance && data.performance.length) { heading("Performance of this analysis"); tableOut(data.performance, [0, 230]); }
    if (data.network_health && data.network_health.length) { heading("Network health (" + ESTIMATE_LINE + ")"); tableOut(data.network_health, [0, 230]); }
    if (data.device_recommendations && data.device_recommendations.length > 1) { heading("Device recommendations (" + ESTIMATE_LINE + ")"); tableOut(data.device_recommendations, [0, 25, 330, 430]); }
    if (data.what_if && data.what_if.length > 1) { heading("Before and after (what-if, " + ESTIMATE_LINE + ")"); tableOut(data.what_if, [0, 200, 290, 380]); }
    heading("Issues");
    if (!data.issues.length) { para("No issues recorded. Run the Smart planner before exporting to include them.", 10); }
    data.issues.forEach(function (t) { para("- " + t, 9); });
    heading("Recommendations");
    if (!data.recommendations.length) { para("No recommendations recorded. Run the Smart planner before exporting to include them.", 10); }
    data.recommendations.forEach(function (t) { para("- " + t, 9); });
    if (data.accessible_text) { heading("Text summary (for screen readers)"); para(data.accessible_text, 9); }
    heading("Disclaimer");
    para("All figures in this report are " + ESTIMATE_LINE.toLowerCase() + ". The model uses log-distance path loss with typical wall losses, and recommendations carry a confidence that expresses model sensitivity, not real-world accuracy. Floor plans and images were processed in the browser and are not uploaded.", 9);
    return pdf.build();
  }

  // ------------------------------------------------------------------ annotations
  /** Draw notes on a 2D context in screen pixels (editor overlay and exports share this). */
  function drawAnnotations(c, view, floor) {
    (floor.annotations || []).forEach(function (a) {
      var x = view.ox + a.x * view.scale, y = view.oy + a.y * view.scale;
      c.save(); c.strokeStyle = "#fbbf24"; c.fillStyle = "#fbbf24"; c.lineWidth = 2;
      if (a.kind === "arrow") {
        var x2 = view.ox + a.x2 * view.scale, y2 = view.oy + a.y2 * view.scale, ang = Math.atan2(y2 - y, x2 - x);
        c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
        c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - 10 * Math.cos(ang - 0.4), y2 - 10 * Math.sin(ang - 0.4)); c.lineTo(x2 - 10 * Math.cos(ang + 0.4), y2 - 10 * Math.sin(ang + 0.4)); c.closePath(); c.fill();
      } else if (a.kind === "pin") {
        c.beginPath(); c.arc(x, y - 10, 7, 0, Math.PI * 2); c.fill(); c.beginPath(); c.moveTo(x - 4, y - 5); c.lineTo(x, y); c.lineTo(x + 4, y - 5); c.fill();
      }
      if (a.text) {
        c.font = "12px system-ui, sans-serif"; c.textAlign = "left";
        var w = c.measureText(a.text).width + 8, ty = a.kind === "pin" ? y - 30 : y - 8;
        c.fillStyle = "rgba(0,0,0,.65)"; c.fillRect(x + 6, ty - 12, w, 17); c.fillStyle = "#fde68a"; c.fillText(a.text, x + 10, ty);
      }
      c.restore();
    });
  }

  // ------------------------------------------------------------------ browser composition
  function bytesOfDataUrl(url) {
    var b = root.atob(url.slice(url.indexOf(",") + 1)), out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) { out[i] = b.charCodeAt(i); }
    return out;
  }
  function legendLines(app) { return app.config.analytics.quality_bands.map(function (b) { return b.id + (b.min_dbm === null ? "" : " (>= " + b.min_dbm + " dBm)"); }); }

  /** Composite canvas of the current view: plan, heat map, overlays, legend and estimate label. */
  function composeView(app) {
    app.editor.drawNow();
    var doc = root.document, base = doc.getElementById("cBase"), heat = app.renderer.canvas, over = doc.getElementById("cOver"), edit = doc.getElementById("cEdit");
    var out = doc.createElement("canvas"), W = edit.width, H = edit.height, c = out.getContext("2d");
    out.width = W; out.height = H;
    c.fillStyle = getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim() || "#080b12"; c.fillRect(0, 0, W, H);
    [base, heat, over, edit].forEach(function (cv) { if (cv && cv.width) { c.drawImage(cv, 0, 0, W, H); } });
    var dpr = W / edit.clientWidth, pad = 10 * dpr, fs = 12 * dpr;
    c.font = fs + "px system-ui, sans-serif"; c.textBaseline = "top";
    var lines = legendLines(app), bw = LEGEND_W * dpr, bh = (lines.length + 2) * fs * 1.4 + pad;
    c.fillStyle = "rgba(0,0,0,.7)"; c.fillRect(W - bw - pad, pad, bw, bh);
    c.fillStyle = "#fff"; c.fillText("Signal quality", W - bw, pad + 4 * dpr);
    var H2 = root.PlannerHeat;
    lines.forEach(function (l, i) {
      var id = l.split(" ")[0], col = H2.bandColor(app.paletteId || "classic", id), y = pad + (i + 1.4) * fs * 1.4;
      c.fillStyle = "rgb(" + col.join(",") + ")"; c.fillRect(W - bw, y, fs, fs); c.fillStyle = "#fff"; c.fillText(l, W - bw + fs * 1.4, y);
    });
    c.fillStyle = "rgba(0,0,0,.7)"; c.fillRect(0, H - fs * 2.2, W, fs * 2.2);
    c.fillStyle = "#fbbf24"; c.fillText(ESTIMATE_LINE + " | " + app.store.project.name + " | " + app.currentFloor().name, pad, H - fs * 1.7);
    return out;
  }

  /** Small JPEG of the quality map of one propagation mode, drawn from the engine grid (one square per analysis cell). */
  function modeMap(app, mode) {
    var E = root.RFEngine, floor = app.currentFloor(), cell = root.PlannerPanels.analysisCell(floor);
    var g = E.coverageGrid(app.store.project, floor.id, { env: app.env, cellM: cell, mode: mode, band: app.settings.band || undefined });
    var scale = Math.max(1, Math.floor(MODE_MAP_PX / Math.max(g.cols, g.rows))), cv = root.document.createElement("canvas"), c = cv.getContext("2d");
    cv.width = g.cols * scale; cv.height = g.rows * scale;
    for (var r = 0; r < g.rows; r++) {
      for (var k = 0; k < g.cols; k++) {
        var col = root.PlannerHeat.bandColor(app.paletteId || "classic", E.qualityBand(app.config, g.rssi[r][k]));
        c.fillStyle = "rgb(" + col.join(",") + ")"; c.fillRect(k * scale, r * scale, scale, scale);
      }
    }
    return { label: mode.charAt(0).toUpperCase() + mode.slice(1), coverage_pct: g.coverage_pct, image: { bytes: bytesOfDataUrl(cv.toDataURL("image/jpeg", JPEG_QUALITY)), w: cv.width, h: cv.height } };
  }

  /** Optional report sections computed from the live project and last analysis. */
  /**
   * PDF tables from the last Timeline and what-if tab results (`recs` from the recommend job, `whatIf` from the what-if panel).
   * Missing results give empty tables, which the report leaves out: nothing is computed here, so nothing is invented.
   */
  function labReportTables(recs, whatIf) {
    var health = [], devices = [], diff = [];
    if (recs) { health = [["Metric", "Value"], ["Coverage score", recs.score + " out of 100"], ["Ranked actions found", String(recs.actions.length)]]; }
    if (recs && recs.actions.length) {
      devices = [["#", "Action", "Score", "Confidence"]].concat(recs.actions.slice(0, 8).map(function (a) { return [a.rank, a.text, a.before.score + " to " + a.after.score, a.confidence]; }));
    }
    if (whatIf && whatIf.before && whatIf.after) {
      diff = [["Measure", "Before", "After", "Change"], ["Coverage score", whatIf.before.score, whatIf.after.score, whatIf.delta.score], ["Coverage (%)", whatIf.before.coverage_pct, whatIf.after.coverage_pct, whatIf.delta.coverage_pct],
        ["Mean speed (Mbps)", whatIf.before.mean_throughput_mbps, whatIf.after.mean_throughput_mbps, whatIf.delta.mean_throughput_mbps]];
    }
    return { health: health, devices: devices, what_if: diff };
  }

  function reportExtras(app, an) {
    var project = app.store.project, fl = app.currentFloor(), res = app.lastResult;
    var floors = [["Floor", "Level", "APs", "Walls", "Size (m)", "Status"]].concat(project.floors.map(function (f) {
      return [f.name, f.level, f.aps.length, f.walls.length, f.width_m + " x " + f.depth_m, f.id === fl.id ? "shown" : ""]; }));
    var locations = [["AP", "Floor", "x (m)", "y (m)", "TX dBm", "Band"]];
    project.floors.forEach(function (f) { f.aps.forEach(function (a) { locations.push([a.id, f.name, a.x, a.y, a.tx_dbm, (a.band || app.settings.band || "2.4") + " GHz"]); }); });
    var spectrum = [["AP", "Band", "Channel", "Width MHz", "Co-channel"]].concat(an.aps.map(function (a) { return [a.id, a.band + " GHz", a.channel, a.width_mhz, a.cochannel_neighbours.join(" ") || "none"]; }));
    (project.interferers || []).forEach(function (x) { spectrum.push([x.id, x.kind, x.channel || "-", "-", "source on " + x.floor]); });
    var performance = [["Metric", "Value"], ["Heat map compute time", res && res.stats ? Math.round(res.stats.ms) + " ms" : "n/a"], ["Analysis grid", an.cols + " x " + an.rows + " cells of " + an.cell_m + " m"],
      ["Walls on this floor", fl.walls.length], ["Renderer", app.rendererInfo || "n/a"]];
    var modes = root.RFEngine.modeIds().map(function (m) { return modeMap(app, m); });
    var text = "Floor " + fl.name + " of " + project.name + ": coverage " + an.coverage_pct + " percent at " + app.config.analytics.coverage_dbm + " dBm, " + an.dead_zones.length +
      " dead zones, " + an.aps.length + " access points. All values are model estimates, not measurements.";
    var lab = app.twinLab && app.twinLab.state ? app.twinLab.state : {}, extra = labReportTables(lab.recs, lab.whatIf);
    return { network_health: extra.health, device_recommendations: extra.devices, what_if: extra.what_if, floors: floors, ap_locations: locations, spectrum: spectrum, performance: performance, mode_maps: modes, accessible_text: text };
  }

  function pngBytes(app) { return bytesOfDataUrl(composeView(app).toDataURL("image/png")); }
  function safeName(s) { return String(s || "project").replace(/[^\w.-]+/g, "_"); }

  // ------------------------------------------------------------------ built-in exporters
  function registerBuiltins() {
    register("png", { label: "PNG image (current view)", run: function (ctx) { return { name: safeName(ctx.app.store.project.name) + "-" + ctx.app.currentFloor().id + ".png", mime: "image/png", data: pngBytes(ctx.app) }; } });
    register("csv", { label: "CSV analytics", run: function (ctx) {
      var an = ctx.analysis();
      return { name: safeName(ctx.app.store.project.name) + "-analytics.csv", mime: "text/csv", data: toCsv(analyticsRows(an.analytics, { project: ctx.app.store.project.name, floor: ctx.app.currentFloor().name })) };
    } });
    register("json", { label: "Project JSON", run: function (ctx) { return { name: safeName(ctx.app.store.project.name) + ".wallhack-plan.json", mime: "application/json", data: root.PlannerState.exportProjectJson(ctx.app.store.project) }; } });
    register("pdf", { label: "PDF coverage report", run: function (ctx) {
      var app = ctx.app, an = ctx.analysis().analytics, plan = ctx.plan(), fl = app.currentFloor();
      var cv = composeView(app), jpeg = bytesOfDataUrl(cv.toDataURL("image/jpeg", JPEG_QUALITY));
      var summary = [["Metric", "Value"], ["Coverage at -70 dBm", an.coverage_pct + " %"], ["Average RSSI", an.avg_rssi_dbm + " dBm"], ["Weak area", an.weak_area_m2 + " m2"],
        ["Dead zones", an.dead_zones.length + " (" + an.dead_zone_area_m2 + " m2)"], ["AP overlap", an.overlap.pct + " %"], ["Roaming zones", an.roaming.pct + " %"],
        ["Mean throughput (ESTIMATE)", an.mean_throughput_mbps + " Mbps"], ["Client capacity (ESTIMATE)", an.total_client_capacity]];
      var aps = [["AP", "Band", "Channel", "Served m2", "Usable Mbps*", "Capacity*", "Utilisation*"]].concat(an.aps.map(function (a) {
        return [a.id, a.band + " GHz", a.channel, a.served_area_m2, a.usable_mbps, a.client_capacity, a.channel_utilisation_pct + " %"]; }));
      aps.push(["* ESTIMATE"]);
      var extras = reportExtras(app, an);
      return { name: safeName(app.store.project.name) + "-coverage-report.pdf", mime: "application/pdf", data: buildReport(Object.assign(extras, {
        title: "Wallhack RF coverage report", project: app.store.project.name, floor: fl.name, date: new Date().toISOString().slice(0, 10), summary: summary, aps: aps,
        issues: plan ? plan.issues.map(function (i) { return i.severity + ": " + i.text; }) : [], recommendations: plan ? ctx.recommendations().map(function (r) { return r.text + " (confidence " + (r.confidence === null ? "n/a" : Math.round(r.confidence * 100) + "%") + ". Why: " + r.reason + ")"; }) : [],
        image: { bytes: jpeg, w: cv.width, h: cv.height } })) };
    } });
    register("print", { label: "Print or save as PDF (browser)", run: function () { root.print(); return null; } });
  }
  registerBuiltins.names = ["png", "csv", "json", "pdf", "print"];

  // ------------------------------------------------------------------ mount (annotations, buttons, drag and drop)
  function mount(app) {
    var P = root.PlannerPanels, S = root.PlannerState, el = P.el;
    var panel = app.tabs.add("export", "Export"), msg = el("p", { class: "muted", role: "status", id: "exportStatus" });
    var note = { text: "Note", start: null };
    var ctx = {
      app: app,
      analysis: function () { var a = app.panels.state.analysis; if (!a) { throw new Error("analytics are not ready yet, wait for the heat map to finish"); } return a; },
      plan: function () { return app.panels.state.plan; },
      recommendations: function () { return app.panels.state.recs; }
    };
    function run(id) {
      try {
        var r = get(id).run(ctx);
        if (!r) { msg.textContent = "Opened " + get(id).label; return; }
        Promise.resolve(r).then(function (res) {
          app.download(res.name, res.mime, res.data); msg.textContent = "Exported " + res.name + " (" + (res.data.length || res.data.size || 0) + " bytes)";
        }).catch(function (e) { msg.textContent = "Export failed: " + e.message; });
      } catch (e) { msg.textContent = "Export failed: " + e.message; }
    }
    app.exportRun = run;
    function render() {
      panel.textContent = "";
      panel.appendChild(el("p", { class: "muted hint", text: "Exports stay on this device. PNG and PDF include the heat map with the label \"" + ESTIMATE_LINE + "\"." }));
      var row = el("div", { class: "tool-row" });
      list().forEach(function (x) { row.appendChild(P.button(x.label, function () { run(x.id); }, { "data-export": x.id })); });
      panel.appendChild(row);
      var imp = el("input", { type: "file", accept: "application/json,.json", hidden: "", id: "exportImport" });
      imp.addEventListener("change", function () { var f = imp.files[0]; imp.value = ""; if (f) { importFile(f); } });
      panel.appendChild(el("div", { class: "tool-row" }, [P.button("Load project JSON", function () { imp.click(); }), imp, el("span", { class: "muted hint", text: "or drop a project .json file on the plan" })]));
      panel.appendChild(el("h3", { text: "Annotations" }));
      var text = el("input", { type: "text", maxlength: String(S.textLimit(app.validateOpts())), value: note.text, "aria-label": "Note text", id: "noteText" });
      text.addEventListener("input", function () { note.text = text.value || "Note"; });
      var tools = el("div", { class: "tool-row" }, [el("label", { class: "inline" }, ["Text ", text])]);
      [["note-text", "Text note"], ["note-arrow", "Arrow"], ["note-pin", "Pin"]].forEach(function (t) {
        tools.appendChild(P.button(t[1], function () { app.editor.setTool(t[0]); }, { "data-tool": t[0], "aria-pressed": "false" }));
      });
      panel.appendChild(tools);
      var f = app.currentFloor();
      panel.appendChild(P.table("Notes on " + f.name + " (stored in the project)", ["Kind", "Text", "Position", "Remove"], (f.annotations || []).map(function (a) {
        return [a.kind, a.text || "", a.x.toFixed(1) + ", " + a.y.toFixed(1) + " m", P.button("Delete", function () { app.store.exec({ label: "Delete note", ops: [S.removeOp("annotation", app.store.project, f.id, a.id)] }); }, { "aria-label": "Delete note " + (a.text || a.kind) })];
      })));
      panel.appendChild(msg);
    }
    function importFile(file) {
      if (file.size > 12 * 1024 * 1024) { app.notice("Import refused: the file is larger than 12 MB.", "error"); return; }
      var r = new root.FileReader();
      r.onload = function () {
        try { app.store.load(S.parseProjectJson(r.result, app.validateOpts())); app.notice(""); app.say("Imported " + file.name); app.editor.fit(); }
        catch (e) { app.notice("Import failed: " + e.message, "error"); }
      };
      r.onerror = function () { app.notice("Could not read the file.", "error"); };
      r.readAsText(file);
    }
    var stage = root.document.getElementById("stage");
    stage.addEventListener("dragover", function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { e.preventDefault(); } });
    stage.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && (/json$/i.test(f.name) || f.type === "application/json")) { e.preventDefault(); e.stopPropagation(); importFile(f); }
    }, true);

    app.noteTool = function (tool, phase, raw) {
      var f = app.currentFloor(), st = app.store;
      function add(item) { st.exec({ label: "Add note", ops: [S.addOp("annotation", st.project, f.id, Object.assign({ id: S.nextId(f.annotations, "n") }, item))] }); }
      var p = { x: Math.min(f.width_m, Math.max(0, raw.x)), y: Math.min(f.depth_m, Math.max(0, raw.y)) };
      if (tool === "note-text" && phase === "down") { add({ kind: "text", x: p.x, y: p.y, text: note.text }); return true; }
      if (tool === "note-pin" && phase === "down") { add({ kind: "pin", x: p.x, y: p.y, text: note.text }); return true; }
      if (tool === "note-arrow") {
        if (phase === "down") { note.start = p; return true; }
        if (phase === "up" && note.start) {
          var s = note.start; note.start = null;
          if (Math.hypot(p.x - s.x, p.y - s.y) > 0.2) { add({ kind: "arrow", x: s.x, y: s.y, x2: p.x, y2: p.y, text: note.text }); }
          return true;
        }
        return phase === "move";
      }
      return false;
    };
    app.overlay(drawAnnotations);
    app.store.subscribe(function (ev) { if (ev.source !== "select") { render(); } });
    render();
    app.tabs.rerenderExport = render;
  }

  var api = { register: register, list: list, get: get, csvCell: csvCell, toCsv: toCsv, analyticsRows: analyticsRows, createPdf: createPdf, buildReport: buildReport,
              wrapText: wrapText, drawAnnotations: drawAnnotations, composeView: composeView, mount: mount, labReportTables: labReportTables, ESTIMATE_LINE: ESTIMATE_LINE };
  registerBuiltins();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerExport = api;
})(typeof self !== "undefined" ? self : this);
