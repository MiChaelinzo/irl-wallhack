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
  var DEMO = window.WALLHACK_DEMO || null;  // set only by the static demo build (demo.js)
  var ws = null, retryMs = 500, pollTimer = null, wsOpen = false;

  var HISTORY_POINTS = 120;        // client-side sparkline history per environment metric
  var HEART_MIN_HZ_NOTE = "Heart rate needs CSI at 8 Hz or more. Low confidence.";
  var SENSORS_HINT = "no sensor. Start with --sensors";
  var AQI_BANDS = [[50, "--aqi-good"], [100, "--aqi-moderate"], [150, "--aqi-sensitive"], [200, "--aqi-unhealthy"], [300, "--aqi-very"], [500, "--aqi-hazardous"]];
  var AQI_MAX = 500;
  var AQI_RING_START = 0.75 * Math.PI, AQI_RING_SPAN = 1.5 * Math.PI;
  // key: reading field; rating: key in environment.ratings; derived: top-level report field
  var TILES = [
    { id: "pm25", label: "PM2.5", unit: "ug/m3", field: "pm25", rating: "particulates", digits: 1 },
    { id: "pm10", label: "PM10", unit: "ug/m3", field: "pm10", rating: "particulates", digits: 1 },
    { id: "co2", label: "CO2", unit: "ppm", field: "co2", rating: "co2", digits: 0 },
    { id: "tvoc", label: "TVOC", unit: "ppb", field: "tvoc_ppb", rating: "tvoc", digits: 0 },
    { id: "hcho", label: "HCHO", unit: "ppb", field: "hcho_ppb", rating: "hcho", digits: 0 },
    { id: "temp", label: "Temperature", unit: "\u00b0C", field: "temperature_c", digits: 1 },
    { id: "hum", label: "Humidity", unit: "%", field: "humidity_pct", rating: "humidity", digits: 0 },
    { id: "dew", label: "Dew point", unit: "\u00b0C", derived: "dew_point_c", digits: 1 },
    { id: "heat", label: "Heat index", unit: "\u00b0C", derived: "heat_index_c", digits: 1 },
    { id: "surf", label: "Surface temp", unit: "\u00b0C", field: "surface_temp_c", digits: 1 }
  ];
  var envHistory = {};             // tile id -> [values]
  var tileEls = {};

  var soundOn = false, audio = null, prevPresence = false, prevMotion = false;

  function $(id) { return document.getElementById(id); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function getJson(url) {
    if (DEMO) { return DEMO.getJson(url); }
    return fetch(url).then(function (r) {
      if (!r.ok) { throw new Error(url + " returned " + r.status); }
      return r.json();
    });
  }
  // Shared with twin.js, panels.js and game.js, which load after this file.
  window.Wallhack = { getJson: getJson, demo: DEMO };
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
    $("offline").hidden = true;
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
    setPill("pPresence", st.presence ? "on" : "off");
    setPill("pMotion", st.motion ? "alert" : "off");
    setPill("pBreathing", st.breathing_bpm !== null && st.breathing_bpm !== undefined ? "on" : (st.breathing_supported === false ? "na" : "off"),
      st.breathing_supported === false ? "Breathing (n/a)" : "Breathing");
    alertOnChange(st);
    var mode = $("mode"), simulated = st.source === "simulator";
    mode.hidden = false; mode.textContent = simulated ? "SIMULATED" : "REAL";
    mode.className = "chip " + (simulated ? "warn" : "ok");
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
    renderVitals(st);
    renderEnvironment(st.environment);
    if (window.Room3D) { Room3D.update(latest.zones, latest.links, st.vitals, palette3d()); }
  }

  function palette3d() {
    return { bad: css("--bad"), ok: css("--ok"), muted: css("--muted"), line: css("--line"), fg: css("--fg"),
             accent: css("--accent"), accent2: css("--accent2"), warn: css("--warn") };
  }

  // ---- vitals ------------------------------------------------------------
  function renderVitals(st) {
    var v = st.vitals;
    if (!v) { return; }
    $("vitalsSim").hidden = !v.simulated;
    var hasHeart = v.heart_bpm !== null && v.heart_bpm !== undefined;
    $("heartVal").textContent = hasHeart ? v.heart_bpm.toFixed(0) : "--";
    $("breathVal").textContent = v.breathing_bpm !== null && v.breathing_bpm !== undefined ? v.breathing_bpm.toFixed(1) : "--";
    var icon = $("heartIcon");
    icon.classList.toggle("live", hasHeart);
    if (hasHeart) { icon.style.setProperty("--beat", (60 / v.heart_bpm).toFixed(2) + "s"); }
    var act = $("activityBadge");
    act.className = "act " + v.activity; act.textContent = v.activity;
    var note = $("vitalsNote");
    note.hidden = v.heart_supported !== false;
    note.textContent = v.heart_supported === false ? "Low confidence: " + HEART_MIN_HZ_NOTE : "";
  }

  // ---- environment -------------------------------------------------------
  function buildTiles() {
    var grid = $("envGrid");
    TILES.forEach(function (t) {
      var el = document.createElement("div");
      el.className = "tile empty";
      var ribbon = document.createElement("span"); ribbon.className = "ribbon"; ribbon.textContent = "SIMULATED"; ribbon.hidden = true;
      var label = document.createElement("div"); label.className = "label"; label.textContent = t.label;
      var val = document.createElement("div"); val.className = "val";
      var spark = document.createElement("canvas"); spark.width = 140; spark.height = 28; spark.setAttribute("aria-hidden", "true");
      el.appendChild(ribbon); el.appendChild(label); el.appendChild(val); el.appendChild(spark);
      grid.appendChild(el);
      tileEls[t.id] = { el: el, ribbon: ribbon, val: val, spark: spark };
      envHistory[t.id] = [];
    });
  }

  // Explain an empty tile from the real sensor status instead of always suggesting --sensors.
  function emptyTileHint(env) {
    var names = Object.keys((env && env.sensors) || {});
    if (!names.length) { return SENSORS_HINT; }
    var problems = names.filter(function (n) { return env.sensors[n].state !== "ok"; }).map(function (n) {
      var st = env.sensors[n];
      return n + " " + st.state + (st.message ? " (" + st.message + ")" : "");
    });
    return problems.length ? "sensor offline: " + problems.join("; ") : "no reading from the configured sensors";
  }

  function tileValue(t, env) {
    if (!env) { return null; }
    var v = t.derived ? env[t.derived] : env.reading[t.field];
    return v === undefined ? null : v;
  }

  function renderEnvironment(env) {
    var head = $("envHead"), chips = $("envChips");
    head.textContent = ""; chips.textContent = "";
    TILES.forEach(function (t) {
      var ref = tileEls[t.id], v = tileValue(t, env);
      ref.ribbon.hidden = !(env && env.simulated);
      ref.val.textContent = "";
      if (v === null) {
        ref.el.className = "tile empty";
        ref.val.textContent = "--";
        var hint = document.createElement("div"); hint.className = "muted hint";
        hint.textContent = t.derived ? (env ? "not available for these conditions" : SENSORS_HINT) : emptyTileHint(env);
        ref.val.appendChild(hint);
        drawSpark(ref.spark, []);
        return;
      }
      var level = t.rating && env.ratings ? env.ratings[t.rating] : null;
      ref.el.className = "tile" + (level ? " " + level : "");
      ref.val.appendChild(document.createTextNode(v.toFixed(t.digits)));
      var unit = document.createElement("span"); unit.className = "unit"; unit.textContent = t.unit;
      ref.val.appendChild(unit);
      var hist = envHistory[t.id]; hist.push(v);
      if (hist.length > HISTORY_POINTS) { hist.shift(); }
      drawSpark(ref.spark, hist);
    });
    if (!env) {
      head.textContent = "No environment sensors configured.";
      head.className = "env-head muted";
      return;
    }
    head.className = "env-head";
    var aqiBox = document.createElement("div"); aqiBox.className = "aqi";
    var ring = document.createElement("canvas"); ring.width = 220; ring.height = 220; ring.setAttribute("aria-label", "Air quality index ring");
    aqiBox.appendChild(ring);
    var overall = document.createElement("div"); overall.className = "overall";
    var lvl = env.overall && env.overall.level;
    var b = document.createElement("b"); b.textContent = lvl || "no data";
    overall.appendChild(document.createTextNode("Air quality: ")); overall.appendChild(b);
    if (env.overall && env.overall.drivers.length) {
      var d = document.createElement("div"); d.className = "muted";
      d.textContent = "driven by " + env.overall.drivers.join(", ");
      overall.appendChild(d);
    }
    if (env.aqi) {
      var cat = document.createElement("div"); cat.className = "muted"; cat.textContent = "US EPA AQI: " + env.aqi.category; overall.appendChild(cat);
    }
    if (env.simulated) {
      var sim = document.createElement("div"); sim.className = "chip sim"; sim.textContent = "SIMULATED"; overall.appendChild(sim);
    }
    aqiBox.appendChild(overall); head.appendChild(aqiBox);
    drawAqiRing(ring, env.aqi);
    Object.keys(env.sensors || {}).forEach(function (name) {
      var st = env.sensors[name], c = document.createElement("span");
      c.className = "chip " + (st.state === "ok" ? "ok" : (st.state === "error" ? "error" : (st.state === "stale" || st.state === "warming" ? "stale" : "waiting")));
      c.textContent = name + ": " + st.state;
      if (st.message) { c.title = st.message; }
      chips.appendChild(c);
    });
  }

  function drawSpark(canvas, hist) {
    var g = ctxOf(canvas), w = canvas.width, h = canvas.height;
    if (hist.length < 2) { return; }
    var lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
    if (hi - lo < 1e-6) { hi = lo + 1; }
    g.strokeStyle = css("--accent"); g.lineWidth = 1.5; g.beginPath();
    hist.forEach(function (v, i) {
      var x = w * i / (HISTORY_POINTS - 1) + w * (HISTORY_POINTS - hist.length) / (HISTORY_POINTS - 1);
      var y = h - 3 - (h - 6) * (v - lo) / (hi - lo);
      if (i === 0) { g.moveTo(x, y); } else { g.lineTo(x, y); }
    });
    g.stroke();
  }

  function drawAqiRing(canvas, aqi) {
    var g = ctxOf(canvas), cx = canvas.width / 2, cy = canvas.height / 2, r = 86;
    g.lineWidth = 18; g.lineCap = "butt";
    var from = 0;
    AQI_BANDS.forEach(function (b) {
      g.strokeStyle = css(b[1]); g.globalAlpha = 0.9;
      g.beginPath(); g.arc(cx, cy, r, AQI_RING_START + AQI_RING_SPAN * from / AQI_MAX, AQI_RING_START + AQI_RING_SPAN * b[0] / AQI_MAX); g.stroke();
      from = b[0];
    });
    g.globalAlpha = 1; g.textAlign = "center";
    if (aqi) {
      var a = AQI_RING_START + AQI_RING_SPAN * Math.min(aqi.aqi, AQI_MAX) / AQI_MAX;
      g.fillStyle = css("--fg"); g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 11, 0, 2 * Math.PI); g.fill();
      g.font = "bold 44px system-ui, sans-serif"; g.fillText(String(aqi.aqi), cx, cy + 12);
    } else {
      g.fillStyle = css("--muted"); g.font = "bold 40px system-ui, sans-serif"; g.fillText("--", cx, cy + 12);
    }
    g.fillStyle = css("--muted"); g.font = "18px system-ui, sans-serif"; g.fillText("AQI", cx, cy + 40);
    g.textAlign = "left";
  }

  // Optional beep, off by default. Needs a user gesture to start, which the toggle provides.
  function alertOnChange(st) {
    if (soundOn && ((st.motion && !prevMotion) || (st.presence && !prevPresence && !st.motion))) { beep(st.motion ? 880 : 520); }
    prevPresence = !!st.presence; prevMotion = !!st.motion;
  }
  function beep(freq) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), gain = audio.createGain();
      o.frequency.value = freq; gain.gain.value = 0.05;
      o.connect(gain); gain.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.15);
    } catch (e) { /* audio unavailable */ }
  }

  function setPill(id, state, label) {
    var el = $(id);
    el.className = "pill " + state;
    if (label) { el.textContent = label; }
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
    if (!isFinite(min)) {
      g.fillStyle = css("--muted"); g.font = "14px sans-serif"; g.fillText("Waiting for readings...", pad, h / 2);
      return;
    }
    if (floor !== null) { min = floor; }
    if (max - min < 1) { max = min + 1; }
    g.strokeStyle = css("--line"); g.fillStyle = css("--muted"); g.font = "12px sans-serif"; g.lineWidth = 1;
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
    g.strokeStyle = css("--line"); g.beginPath(); g.arc(cx, cy, r, Math.PI, 2 * Math.PI); g.stroke();
    if (bpm !== null && bpm !== undefined) {
      var f = Math.min(1, Math.max(0, (bpm - lo) / (hi - lo)));
      g.strokeStyle = css("--accent"); g.beginPath(); g.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * f); g.stroke();
    }
    g.fillStyle = css("--fg"); g.textAlign = "center"; g.font = "bold 34px sans-serif";
    g.fillText(bpm === null || bpm === undefined ? "--" : bpm.toFixed(1), cx, cy - 8);
    g.fillStyle = css("--muted"); g.font = "12px sans-serif";
    g.fillText("breaths/min", cx, cy + 12);
    g.textAlign = "left";
  }

  function drawHeat(canvas, zones) {
    var g = ctxOf(canvas), w = canvas.width, h = canvas.height;
    if (!zones.length) {
      g.fillStyle = css("--muted"); g.font = "14px sans-serif"; g.fillText("No zones yet", 10, 24);
      return;
    }
    var cols = Math.min(zones.length, 3), rows = Math.ceil(zones.length / cols);
    var cw = w / cols, ch = h / rows;
    zones.forEach(function (z, i) {
      var x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      var level = z.motion ? 1 : (z.presence ? 0.55 : 0.08);
      g.fillStyle = css(z.motion ? "--bad" : (z.presence ? "--ok" : "--muted"));
      g.globalAlpha = level * 0.6;
      g.fillRect(x + 3, y + 3, cw - 6, ch - 6);
      g.globalAlpha = 1;
      g.fillStyle = css("--fg"); g.font = "bold 14px sans-serif";
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
      getJson("/api/status"), getJson("/api/zones"), getJson("/api/links"),
      getJson("/api/events?limit=20"), getJson("/api/samples?limit=600&since=" + lastSeq)
    ]).then(function (a) {
      if (!wsOpen) { setConn("polling", "warn"); }  // a late poll must not overwrite "live"
      ingest({ status: a[0], zones: a[1], links: a[2], events: a[3], samples: a[4] });
    }).catch(function () { setConn("offline", "warn"); $("offline").hidden = false; });
  }

  function resetClient() {
    series = {}; motionSeries = {}; lastSeq = 0; Object.keys(envHistory).forEach(function (k) { envHistory[k] = []; });
  }

  function startPolling() { if (DEMO) { return; } if (!pollTimer) { poll(); pollTimer = setInterval(poll, POLL_MS); } }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function connect() {
    if (DEMO) { DEMO.play(ingest, resetClient, setConn); return; }
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
    getJson("/api/settings").then(function (s) {
      fillSelect($("setSource"), s.sources, s.source);
      fillSelect($("setScenario"), s.scenarios, s.scenario);
      $("setSens").value = s.sensitivity; $("sensVal").textContent = Number(s.sensitivity).toFixed(2);
      $("setMsg").textContent = "";
      $("setSound").checked = soundOn;
      $("drawer").hidden = false; $("settingsBtn").setAttribute("aria-expanded", "true");
    }).catch(function (e) { $("note").hidden = false; $("note").textContent = "Could not load settings: " + e.message; });
  }
  function closeDrawer() { $("drawer").hidden = true; $("settingsBtn").setAttribute("aria-expanded", "false"); }

  function applySettings() {
    if (DEMO) { $("setMsg").textContent = DEMO.readOnlyMessage; return; }
    var body = { source: $("setSource").value, scenario: $("setScenario").value, sensitivity: parseFloat($("setSens").value) };
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) { return r.json().then(function (e) { throw new Error(JSON.stringify(e.detail)); }); }
        resetClient();
        $("setMsg").textContent = "Applied.";
      })
      .catch(function (e) { $("setMsg").textContent = "Error: " + e.message; });
  }

  // ---- theme, calibrate, export -----------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var btn = $("themeBtn");
    btn.textContent = theme === "light" ? "Dark" : "Light";
    btn.setAttribute("aria-pressed", String(theme === "light"));
    render();
  }

  function calibrate() {
    var msg = $("note");
    if (DEMO) { msg.hidden = false; msg.textContent = DEMO.readOnlyMessage; return; }
    fetch("/api/calibrate", { method: "POST" }).then(function (r) {
      if (!r.ok) { throw new Error("server returned " + r.status); }
      motionSeries = {};
      msg.hidden = false; msg.textContent = "Calibrated: baselines reset. Keep the space empty and still for about 30 seconds.";
    }).catch(function (e) { msg.hidden = false; msg.textContent = "Calibration failed: " + e.message; });
  }

  function download(name, type, text) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvCell(v) {
    var t = String(v === null || v === undefined ? "" : v);
    if (/^[=+\-@]/.test(t)) { t = "'" + t; }  // stop spreadsheet formula injection
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function exportEvents(format) {
    getJson("/api/events?limit=500").then(function (events) {
      if (!events.length) { throw new Error("no events to export"); }
      var stamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (format === "json") { download("wallhack-events-" + stamp + ".json", "application/json", JSON.stringify(events, null, 2)); return; }
      var cols = Object.keys(events[0]);
      var rows = [cols.join(",")].concat(events.map(function (e) { return cols.map(function (c) { return csvCell(e[c]); }).join(","); }));
      download("wallhack-events-" + stamp + ".csv", "text/csv", rows.join("\n") + "\n");
    }).catch(function (e) { $("note").hidden = false; $("note").textContent = "Export failed: " + e.message; });
  }

  function init() {
    soundOn = load("wallhack.sound") === "1";
    applyTheme(load("wallhack.theme") || "dark");
    $("themeBtn").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      store("wallhack.theme", next); applyTheme(next);
    });
    $("calibrateBtn").addEventListener("click", calibrate);
    $("exportJson").addEventListener("click", function () { exportEvents("json"); });
    $("exportCsv").addEventListener("click", function () { exportEvents("csv"); });
    $("setSound").addEventListener("change", function () { soundOn = $("setSound").checked; store("wallhack.sound", soundOn ? "1" : "0"); });
    $("settingsBtn").addEventListener("click", openDrawer);
    $("closeBtn").addEventListener("click", closeDrawer);
    $("applyBtn").addEventListener("click", applySettings);
    $("setSens").addEventListener("input", function () { $("sensVal").textContent = Number($("setSens").value).toFixed(2); });
    $("dismissPrivacy").addEventListener("click", function () {
      $("privacy").hidden = true;
      store("wallhack.privacy", "1");
    });
    if (load("wallhack.privacy") === "1") { $("privacy").hidden = true; }
    buildTiles(); renderEnvironment(null);
    Room3D.init($("room3d"));
    $("rotateBtn").addEventListener("click", function () {
      var on = !Room3D.isAutoRotating();
      Room3D.setAutoRotate(on); $("rotateBtn").setAttribute("aria-pressed", String(on));
    });
    $("zoomIn").addEventListener("click", Room3D.zoomIn);
    $("zoomOut").addEventListener("click", Room3D.zoomOut);
    $("resetView").addEventListener("click", Room3D.reset);
    if (!Room3D.isAutoRotating()) { $("rotateBtn").setAttribute("aria-pressed", "false"); }
    var qualitySel = $("quality3d");
    var savedQuality = load("wallhack.quality");
    if (savedQuality) { Room3D.setQuality(savedQuality); }
    qualitySel.value = Room3D.getQuality();
    qualitySel.addEventListener("change", function () {
      Room3D.setQuality(qualitySel.value); store("wallhack.quality", Room3D.getQuality());
    });
    // automatic drop on a slow device updates the selector but is not saved as the user's choice
    Room3D.onQualityChange(function (q) { qualitySel.value = q; });
    drawGauge($("gauge"), null); drawHeat($("heat"), []);
    connect();
    startPolling();
  }
  init();
})();
