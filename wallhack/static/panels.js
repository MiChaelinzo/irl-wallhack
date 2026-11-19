"use strict";
// Dashboard panels fed by the Python backend: RF intelligence strip, smart home status, health mode,
// insights copilot and timeline playback. Every value is computed server-side (or recorded by
// tools/build_demo.py for the static demo). This file only formats and displays it.
(function () {
  var W = window.Wallhack;
  if (!W) { return; }
  var REFRESH_MS = 5000;
  var TREND = { up: "\u2191", down: "\u2193", flat: "\u2192" };
  var HOME_METRICS = [["co2", "CO2"], ["humidity", "Humidity"], ["temperature", "Temperature"], ["tvoc", "TVOC"],
                      ["pm25", "PM2.5"], ["pm10", "PM10"], ["aqi", "AQI"]];
  var PLAY_TICK_MS = 250;
  var SIGNAL_SPAN_MIN_DB = 1;
  var SIM_CLOCK_START_S = 8 * 3600;   // the demo's simulated clock starts at 08:00:00
  var history = null, pos = 0, playing = false, playTimer = null, inPlayback = false;

  function $(id) { return document.getElementById(id); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function text(tag, cls, str) { var e = document.createElement(tag); if (cls) { e.className = cls; } e.textContent = str; return e; }
  function pad2(n) { return ("0" + n).slice(-2); }
  function fmt(v, digits) { return v === null || v === undefined ? "--" : Number(v).toFixed(digits); }

  // ---- RF intelligence strip ---------------------------------------------
  function renderScores(data) {
    var strip = $("scoreStrip");
    strip.textContent = "";
    data.scores.forEach(function (s) {
      var box = text("div", "score " + s.band, "");
      box.setAttribute("role", "listitem"); box.title = s.detail;
      box.appendChild(text("div", "label", s.label));
      var val = text("div", "val", fmt(s.value, 0));
      val.appendChild(text("span", "trend", " " + (TREND[s.trend] || TREND.flat)));
      box.appendChild(val);
      box.appendChild(text("div", "muted band", s.band));
      strip.appendChild(box);
    });
    $("scoreNote").textContent = data.label || "Coverage is a model estimate. Simulated data is labelled in the dashboard.";
  }

  // ---- smart home cards and health mode ----------------------------------
  function renderHome(h) {
    var grid = $("homeGrid");
    grid.textContent = "";
    HOME_METRICS.forEach(function (m) {
      var r = h.air[m[0]], card = text("div", "home-card " + (r ? r.status.toLowerCase() : "none"), "");
      card.appendChild(text("div", "label", m[1]));
      card.appendChild(text("div", "val", r ? fmt(r.value, r.value % 1 ? 1 : 0) + (r.unit ? " " + r.unit : "") : "--"));
      card.appendChild(text("div", "status", r ? r.status : "no sensor"));
      grid.appendChild(card);
    });
    $("homeNote").textContent = h.simulated ? "SIMULATED air readings. Status bands: Healthy, Warning, Danger." : "Status bands: Healthy, Warning, Danger.";
  }

  function renderHealth(h) {
    var v = h.vitals || {}, box = $("healthVals");
    box.textContent = "";
    [["Breathing, per min", fmt(v.breathing_bpm, 1)], ["Heart rate, bpm (experimental)", fmt(v.heart_bpm, 0)], ["Activity", v.activity || "--"]].forEach(function (p) {
      var d = text("div", "vital", "");
      var inner = document.createElement("div");
      inner.appendChild(text("div", "big", p[1])); inner.appendChild(text("div", "muted", p[0]));
      d.appendChild(inner); box.appendChild(d);
    });
    var sup = $("healthSupported"), uns = $("healthUnsupported");
    sup.textContent = ""; uns.textContent = "";
    (h.supported || []).forEach(function (s) { sup.appendChild(text("li", "", s.label + ": " + s.note)); });
    (h.unsupported || []).forEach(function (s) { uns.appendChild(text("li", "", s.label + ": Not supported. " + s.reason)); });
    $("healthDisclaimer").textContent = (h.simulated ? "SIMULATED. " : "") + "Not medical data. For research purposes only. " + (h.disclaimer || "");
  }

  // ---- insights ------------------------------------------------------------
  function renderInsights(data) {
    var body = $("insightsBody"), reco = $("insightsReco");
    body.textContent = ""; reco.textContent = "";
    if (!data.insights.length) { body.appendChild(text("li", "muted", "Nothing unusual found.")); }
    data.insights.forEach(function (i) {
      var li = text("li", "sev-" + i.severity, "");
      li.appendChild(text("strong", "", i.title + ". ")); li.appendChild(document.createTextNode(i.detail));
      body.appendChild(li);
      if (i.recommendation) { reco.appendChild(text("li", "", i.recommendation)); }
    });
    if (!reco.children.length) { reco.appendChild(text("li", "muted", "No action needed.")); }
    var llm = data.llm || {}, sel = $("llmSelect");
    sel.textContent = "";
    sel.appendChild(new Option("Rules only (no AI)", "rules"));
    if (llm.enabled) { sel.appendChild(new Option(llm.provider + (llm.off_device ? " (cloud, off-device)" : " (local)"), llm.provider)); }
    $("llmDisclosure").textContent = (data.label || "") + " " + (llm.disclosure || "");
    updateLlmControls(llm);
    W.llmInfo = llm;
  }

  function updateLlmControls(llm) {
    var provider = $("llmSelect").value, usable = !W.demo && llm.enabled && provider !== "rules";
    $("llmExplain").disabled = !usable;
    $("llmConfirmRow").hidden = !(usable && llm.off_device);
    $("llmExplain").title = W.demo ? "Not available in the static demo" : (llm.enabled ? "" : "Set llm_provider on the server to enable");
  }

  function explain() {
    var llm = W.llmInfo || {}, out = $("llmOut");
    out.hidden = false; out.textContent = "Asking the model...";
    fetch("/api/insights/explain", { method: "POST", headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ confirm_off_device: $("llmConfirm").checked }) })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) { throw new Error(b.detail || r.status); } return b; }); })
      .then(function (b) { out.textContent = "UNVERIFIED LLM wording (" + b.provider + "): " + b.explanation + " " + b.note; })
      .catch(function (e) { out.textContent = "Explanation failed: " + e.message; });
    void llm;
  }

  // ---- timeline playback ---------------------------------------------------
  function clockLabel(t, meta, sessionT) {
    var s;
    if (meta && meta.simulated) { s = SIM_CLOCK_START_S + t; }
    else {
      var now = new Date(), nowS = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      s = nowS - (sessionT - t);
    }
    s = ((Math.round(s) % 86400) + 86400) % 86400;
    return pad2(Math.floor(s / 3600)) + ":" + pad2(Math.floor(s / 60) % 60) + ":" + pad2(s % 60);
  }

  function drawTimeline() {
    var c = $("tlCanvas"), g = c.getContext("2d"), w = c.width, h = c.height, rows = history.rows;
    g.clearRect(0, 0, w, h);
    var lo = Infinity, hi = -Infinity;
    rows.forEach(function (r) { lo = Math.min(lo, r.signal_dbm); hi = Math.max(hi, r.signal_dbm); });
    if (hi - lo < SIGNAL_SPAN_MIN_DB) { hi = lo + SIGNAL_SPAN_MIN_DB; }
    function x(i) { return 8 + (w - 16) * i / Math.max(1, rows.length - 1); }
    function y(v) { return 8 + (h - 16) * (1 - (v - lo) / (hi - lo)); }
    g.fillStyle = css("--accent2"); g.globalAlpha = 0.18;
    rows.forEach(function (r, i) { if (r.occupancy > 0) { g.fillRect(x(i) - 3, 0, 6, h); } });
    g.globalAlpha = 1; g.strokeStyle = css("--accent"); g.lineWidth = 1.6; g.beginPath();
    rows.forEach(function (r, i) { if (i === 0) { g.moveTo(x(i), y(r.signal_dbm)); } else { g.lineTo(x(i), y(r.signal_dbm)); } });
    g.stroke();
    g.strokeStyle = css("--fg"); g.lineWidth = 2; g.beginPath(); g.moveTo(x(pos), 0); g.lineTo(x(pos), h); g.stroke();
    g.fillStyle = css("--muted"); g.font = "11px system-ui, sans-serif";
    g.fillText(hi.toFixed(0) + " dBm", 10, 14); g.fillText(lo.toFixed(0) + " dBm", 10, h - 4);
  }

  // Median signal of the session: playback shows the modelled coverage shifted by the measured change from it.
  function medianSignal(rows) {
    var v = rows.map(function (r) { return r.signal_dbm; }).sort(function (a, b) { return a - b; });
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }

  function showRow() {
    var r = history.rows[pos], vals = $("tlValues");
    $("tlSlider").value = String(pos);
    $("tlTime").textContent = clockLabel(r.t, history.meta, history.session_t) + (history.meta && history.meta.simulated ? " (simulated clock)" : "");
    vals.textContent = "";
    [["Occupancy", r.occupancy >= 0.5 ? "occupied" : "empty"], ["Motion", fmt(r.motion, 2)], ["CSI trend", fmt(r.csi_trend, 2)],
     ["Signal", fmt(r.signal_dbm, 1) + " dBm"], ["CO2", fmt(r.co2, 0) + " ppm"], ["PM2.5", fmt(r.pm25, 1) + " ug/m3"], ["AQI", fmt(r.aqi, 0)]].forEach(function (p) {
      var d = text("div", "tl-val", ""); d.appendChild(text("div", "label", p[0])); d.appendChild(text("div", "val", p[1])); vals.appendChild(d);
    });
    if (inPlayback) { Room3D.setPlayback(r.signal_dbm - history.median, r.occupancy); }
    drawTimeline();
  }

  function setPlayback(on) {
    inPlayback = on;
    $("playBadge").hidden = !on;
    if (!on) { stop(); Room3D.setPlayback(0, null); }
  }

  function stop() { playing = false; $("tlPlay").textContent = "Play"; if (playTimer) { clearInterval(playTimer); playTimer = null; } }

  function play() {
    if (playing) { stop(); return; }
    if (!history || history.rows.length < 2) { return; }
    playing = true; $("tlPlay").textContent = "Pause"; setPlayback(true);
    if (pos >= history.rows.length - 1) { pos = 0; }
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    playTimer = setInterval(function () {
      pos += reduced ? Math.max(1, Math.round(Number($("tlSpeed").value))) : 1;
      if (pos >= history.rows.length - 1) { pos = history.rows.length - 1; stop(); }
      showRow();
    }, PLAY_TICK_MS / Number($("tlSpeed").value));
    showRow();
  }

  function loadHistory() {
    W.getJson("/api/history?from=0&step=5").then(function (data) {
      history = data; history.median = medianSignal(data.rows);
      var slider = $("tlSlider");
      slider.max = String(Math.max(0, data.rows.length - 1)); slider.disabled = data.rows.length < 2;
      pos = Math.min(pos, Math.max(0, data.rows.length - 1));
      $("tlNote").textContent = (data.meta && data.meta.simulated ? "SIMULATED session. " : "") +
        "Heat overlay: the modelled coverage (estimate) shifted by the signal change measured in this recording. Tick the signal heat option above to see it.";
      if (data.rows.length) { showRow(); } else { $("tlTime").textContent = "no history yet"; }
    }).catch(function (e) { $("tlNote").textContent = "History unavailable: " + e.message; });
  }

  // ---- mobile pairing ---------------------------------------------------------
  var QR_QUIET = 4, QR_PX = 6;   // quiet zone in modules, pixels per module
  function drawQr(rows) {
    var cv = $("pairQr"), n = rows.length, size = (n + 2 * QR_QUIET) * QR_PX, c = cv.getContext("2d");
    cv.width = size; cv.height = size;
    c.fillStyle = "#fff"; c.fillRect(0, 0, size, size);
    c.fillStyle = "#000";
    rows.forEach(function (row, y) {
      for (var x = 0; x < n; x++) { if (row.charAt(x) === "1") { c.fillRect((x + QR_QUIET) * QR_PX, (y + QR_QUIET) * QR_PX, QR_PX, QR_PX); } }
    });
    cv.hidden = false;
  }

  function showPairing() {
    var msg = $("pairMsg");
    if (W.demo) { msg.textContent = "The static demo cannot pair phones. Run Wallhack locally with --lan, or open the simulated mobile view."; return; }
    W.getJson("/api/pair").then(function (p) {
      drawQr(p.qr); $("pairUrl").textContent = p.url; $("pairUrl").hidden = false;
      msg.textContent = p.note;
    }).catch(function () {
      $("pairQr").hidden = true; $("pairUrl").hidden = true;
      msg.textContent = "Pairing is off. LAN mode is not enabled, or this page is not open on the host machine. Follow the steps below.";
    });
  }

  // ---- wiring ----------------------------------------------------------------
  function refresh() {
    if (document.hidden) { return; }
    W.getJson("/api/scores").then(renderScores).catch(function () { /* shown stale until next refresh */ });
    W.getJson("/api/health").then(function (h) { renderHome(h); renderHealth(h); }).catch(function () { /* stale */ });
    W.getJson("/api/insights").then(renderInsights).catch(function (e) { $("llmDisclosure").textContent = "Insights unavailable: " + e.message; });
  }

  function init() {
    $("tlPlay").addEventListener("click", play);
    $("tlLive").addEventListener("click", function () { setPlayback(false); if (history && history.rows.length) { pos = history.rows.length - 1; showRow(); } });
    $("tlSlider").addEventListener("input", function () { pos = Number($("tlSlider").value); stop(); setPlayback(true); showRow(); });
    $("tlSpeed").addEventListener("change", function () { if (playing) { stop(); play(); } });
    $("llmSelect").addEventListener("change", function () { updateLlmControls(W.llmInfo || {}); });
    $("llmExplain").addEventListener("click", explain);
    $("llmExplain").disabled = true;
    $("pairShow").addEventListener("click", showPairing);
    refresh(); loadHistory();
    if (!W.demo) { setInterval(refresh, REFRESH_MS); setInterval(function () { if (!playing && !inPlayback) { loadHistory(); } }, REFRESH_MS * 6); }
  }
  init();
})();
