"use strict";
// Wallhack dashboard. Vanilla JS, no external resources.
(function () {
  var MAX_POINTS = 600;            // ~60 s at 10 Hz
  var COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f778ba", "#a371f7", "#ff7b72"];
  var POLL_MS = 1000;
  var series = {};                 // link -> [{t, rssi}]
  var motionSeries = {};           // link -> [{t, v}]
  var linkOrder = [];
  var latest = { status: null, zones: [], links: [], events: [] };
  var lastSeq = 0;
  var ws = null, retryMs = 500, pollTimer = null, wsOpen = false;

  function $(id) { return document.getElementById(id); }
  function colorFor(link) {
    var i = linkOrder.indexOf(link);
    if (i < 0) { linkOrder.push(link); i = linkOrder.length - 1; }
    return COLORS[i % COLORS.length];
  }

  // ---- data ingestion ----------------------------------------------------
  function ingest(msg) {
    if (msg.samples) {
      msg.samples.forEach(function (s) {
        if (s.seq <= lastSeq) { return; }
        lastSeq = Math.max(lastSeq, s.seq);
        var arr = series[s.link] || (series[s.link] = []);
        arr.push({ t: s.t, rssi: s.rssi });
        if (arr.length > MAX_POINTS) { arr.shift(); }
      });
    }
    if (msg.status) { latest.status = msg.status; }
    if (msg.zones) { latest.zones = msg.zones; }
    if (msg.links) {
      latest.links = msg.links;
      msg.links.forEach(function (l) {
        var arr = motionSeries[l.link] || (motionSeries[l.link] = []);
        arr.push({ t: l.samples, v: l.motion_value });
        if (arr.length > MAX_POINTS) { arr.shift(); }
      });
    }
    if (msg.events) { latest.events = msg.events; }
    render();
  }

  // ---- rendering ---------------------------------------------------------
  function render() {
    var st = latest.status;
    if (!st) { return; }
    var badge = $("badge");
    if (st.motion) { badge.className = "badge moving"; badge.textContent = "Motion detected"; }
    else if (st.presence) { badge.className = "badge present"; badge.textContent = "Presence detected"; }
    else { badge.className = "badge idle"; badge.textContent = "No presence"; }
    $("badgeSub").textContent = "Estimate from signal changes across " + st.links + " link(s)";
    var src = $("source");
    src.textContent = "source: " + st.source;
    src.className = "chip " + (st.source === "simulator" ? "sim" : "ok");
    var note = $("note");
    var text = (st.source === "simulator" ? "SIMULATED data, not real WiFi readings. " : "") + (st.note || "");
    note.hidden = !text; note.textContent = text;
    if (st.disclaimer) { $("disclaimer").textContent = st.disclaimer; }
    drawGraph($("rssi"), series, "rssi", null);
    drawGraph($("motion"), motionSeries, "v", 0);
    drawGauge($("gauge"), st.breathing_bpm);
    drawHeat($("heat"), latest.zones);
    renderLegend();
    renderEvents();
  }

  function renderLegend() {
    var el = $("legend");
    el.textContent = "";
    Object.keys(series).forEach(function (l) {
      var span = document.createElement("span");
      var i = document.createElement("i");
      i.style.background = colorFor(l);
      span.appendChild(i);
      span.appendChild(document.createTextNode(l));
      el.appendChild(span);
    });
  }

  function fmtT(t) {
    var s = Math.max(0, Math.round(t)), m = Math.floor(s / 60);
    return m + ":" + ("0" + (s % 60)).slice(-2);
  }

  function renderEvents() {
    var ul = $("events");
    ul.textContent = "";
    if (!latest.events.length) {
      var li0 = document.createElement("li");
      li0.className = "muted"; li0.textContent = "No events yet";
      ul.appendChild(li0);
      return;
    }
    latest.events.forEach(function (e) {
      var li = document.createElement("li");
      var tm = document.createElement("time");
      tm.textContent = fmtT(e.t);
      li.appendChild(tm);
      li.appendChild(document.createTextNode(e.kind.replace(/_/g, " ") + " in " + e.zone.replace(/_/g, " ") + (e.detail ? " (" + e.detail + ")" : "")));
      ul.appendChild(li);
    });
  }

  // ---- canvas helpers ----------------------------------------------------
  function ctxOf(c) {
    var g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    return g;
  }

  function drawGraph(canvas, data, key, floor) {
    var g = ctxOf(canvas), w = canvas.width, h = canvas.height, pad = 34;
    var min = Infinity, max = -Infinity;
    Object.keys(data).forEach(function (l) {
      data[l].forEach(function (p) { min = Math.min(min, p[key]); max = Math.max(max, p[key]); });
    });
    if (!isFinite(min)) { min = 0; max = 1; }
    if (floor !== null) { min = floor; }
    if (max - min < 1) { max = min + 1; }
    g.strokeStyle = "#2a3240"; g.fillStyle = "#8b97a7"; g.font = "12px sans-serif"; g.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var y = pad / 2 + (h - pad) * i / 4;
      g.beginPath(); g.moveTo(pad, y); g.lineTo(w - 4, y); g.stroke();
      g.fillText((max - (max - min) * i / 4).toFixed(1), 2, y + 4);
    }
    Object.keys(data).forEach(function (l) {
      var arr = data[l];
      if (arr.length < 2) { return; }
      g.strokeStyle = colorFor(l); g.lineWidth = 1.6; g.beginPath();
      arr.forEach(function (p, idx) {
        var x = pad + (w - pad - 4) * idx / (MAX_POINTS - 1) + (w - pad - 4) * (MAX_POINTS - arr.length) / (MAX_POINTS - 1);
        var yy = pad / 2 + (h - pad) * (1 - (p[key] - min) / (max - min));
        if (idx === 0) { g.moveTo(x, yy); } else { g.lineTo(x, yy); }
      });
      g.stroke();
    });
  }

  function drawGauge(canvas, bpm) {
    var g = ctxOf(canvas), w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h - 24, r = 100, lo = 6, hi = 30;
    g.lineWidth = 16; g.lineCap = "round";
    g.strokeStyle = "#2a3240"; g.beginPath(); g.arc(cx, cy, r, Math.PI, 2 * Math.PI); g.stroke();
    if (bpm !== null && bpm !== undefined) {
      var f = Math.min(1, Math.max(0, (bpm - lo) / (hi - lo)));
      g.strokeStyle = "#58a6ff"; g.beginPath(); g.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * f); g.stroke();
    }
    g.fillStyle = "#e6edf3"; g.textAlign = "center"; g.font = "bold 34px sans-serif";
    g.fillText(bpm === null || bpm === undefined ? "--" : bpm.toFixed(1), cx, cy - 8);
    g.fillStyle = "#8b97a7"; g.font = "12px sans-serif";
    g.fillText("breaths/min", cx, cy + 12);
    g.textAlign = "left";
  }

  function drawHeat(canvas, zones) {
    var g = ctxOf(canvas), w = canvas.width, h = canvas.height;
    if (!zones.length) {
      g.fillStyle = "#8b97a7"; g.font = "14px sans-serif"; g.fillText("No zones yet", 10, 24);
      return;
    }
    var cols = Math.min(zones.length, 3), rows = Math.ceil(zones.length / cols);
    var cw = w / cols, ch = h / rows;
    zones.forEach(function (z, i) {
      var x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      var level = z.motion ? 1 : (z.presence ? 0.55 : 0.08);
      var color = z.motion ? "248,81,73" : (z.presence ? "63,185,80" : "139,151,167");
      g.fillStyle = "rgba(" + color + "," + level + ")";
      g.fillRect(x + 3, y + 3, cw - 6, ch - 6);
      g.fillStyle = "#e6edf3"; g.font = "bold 14px sans-serif";
      g.fillText(z.zone.replace(/_/g, " "), x + 12, y + 26);
      g.font = "12px sans-serif";
      g.fillText(z.motion ? "motion" : (z.presence ? "presence" : "quiet"), x + 12, y + 44);
      if (z.breathing_bpm !== null && z.breathing_bpm !== undefined) {
        g.fillText("breathing ~" + z.breathing_bpm + "/min", x + 12, y + 62);
      }
    });
  }

  // ---- transport: WebSocket with polling fallback ------------------------
  function setConn(text, cls) { var c = $("conn"); c.textContent = text; c.className = "chip " + cls; }

  function poll() {
    Promise.all([
      fetch("/api/status").then(function (r) { return r.json(); }),
      fetch("/api/zones").then(function (r) { return r.json(); }),
      fetch("/api/links").then(function (r) { return r.json(); }),
      fetch("/api/events?limit=20").then(function (r) { return r.json(); }),
      fetch("/api/samples?limit=600&since=" + lastSeq).then(function (r) { return r.json(); })
    ]).then(function (a) {
      setConn("polling", "warn");
      ingest({ status: a[0], zones: a[1], links: a[2], events: a[3], samples: a[4] });
    }).catch(function () { setConn("offline", "warn"); });
  }

  function startPolling() { if (!pollTimer) { poll(); pollTimer = setInterval(poll, POLL_MS); } }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    try { ws = new WebSocket(proto + "//" + location.host + "/ws"); } catch (e) { startPolling(); return; }
    ws.onopen = function () { wsOpen = true; retryMs = 500; stopPolling(); setConn("live", "ok"); };
    ws.onmessage = function (ev) { ingest(JSON.parse(ev.data)); };
    ws.onclose = function () {
      wsOpen = false; startPolling();
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    };
    ws.onerror = function () { ws.close(); };
  }

  // ---- settings drawer ---------------------------------------------------
  function fillSelect(sel, items, current) {
    sel.textContent = "";
    items.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v; o.textContent = v; o.selected = v === current;
      sel.appendChild(o);
    });
  }

  function openDrawer() {
    fetch("/api/settings").then(function (r) { return r.json(); }).then(function (s) {
      fillSelect($("setSource"), s.sources, s.source);
      fillSelect($("setScenario"), s.scenarios, s.scenario);
      $("setSens").value = s.sensitivity; $("sensVal").textContent = Number(s.sensitivity).toFixed(2);
      $("setMsg").textContent = "";
      $("drawer").hidden = false; $("settingsBtn").setAttribute("aria-expanded", "true");
    });
  }
  function closeDrawer() { $("drawer").hidden = true; $("settingsBtn").setAttribute("aria-expanded", "false"); }

  function applySettings() {
    var body = { source: $("setSource").value, scenario: $("setScenario").value, sensitivity: parseFloat($("setSens").value) };
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) { return r.json().then(function (e) { throw new Error(JSON.stringify(e.detail)); }); }
        series = {}; motionSeries = {}; lastSeq = 0;
        $("setMsg").textContent = "Applied.";
      })
      .catch(function (e) { $("setMsg").textContent = "Error: " + e.message; });
  }

  function init() {
    $("settingsBtn").addEventListener("click", openDrawer);
    $("closeBtn").addEventListener("click", closeDrawer);
    $("applyBtn").addEventListener("click", applySettings);
    $("setSens").addEventListener("input", function () { $("sensVal").textContent = Number($("setSens").value).toFixed(2); });
    $("dismissPrivacy").addEventListener("click", function () {
      $("privacy").hidden = true;
      try { localStorage.setItem("wallhack.privacy", "1"); } catch (e) { /* storage unavailable */ }
    });
    try { if (localStorage.getItem("wallhack.privacy") === "1") { $("privacy").hidden = true; } } catch (e) { /* ignore */ }
    drawGauge($("gauge"), null); drawHeat($("heat"), []);
    connect();
    startPolling();
  }
  init();
})();
