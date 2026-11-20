"use strict";
// Mobile companion: occupancy, vitals and sensor status from /api/status (polled), or from the
// recording in the static demo. Alerts appear in the page and, when allowed, as browser notifications.
(function () {
  var POLL_MS = 2000, MAX_ALERTS = 20;
  var NOTE_NO_API = "Notifications are not available in this browser. Alerts still appear below.";
  var NOTE_INSECURE = "This browser blocks notifications on plain http network addresses. Alerts still appear below.";
  var METRICS = [["co2", "CO2"], ["temperature", "Temp"], ["humidity", "Humidity"], ["pm25", "PM2.5"], ["tvoc", "TVOC"], ["aqi", "AQI"]];
  var Common = window.WallhackCommon, prev = null, alerts = 0;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, str) { var e = document.createElement(tag); if (cls) { e.className = cls; } e.textContent = str; return e; }
  function fmt(v) { return v === null || v === undefined ? "--" : String(v); }
  function setConn(label, cls) { var c = $("mConn"); c.textContent = label; c.className = "chip " + (cls || ""); }

  // The change worth telling someone about, or null. Pure: easy to test by hand.
  function alertFor(before, now) {
    if (!before) { return null; }
    if (!before.presence && now.presence) { return "Someone is present"; }
    if (before.presence && !now.presence) { return "Space is empty again"; }
    if (!before.motion && now.motion) { return "Movement detected"; }
    return null;
  }

  function notify(message) {
    if (!("Notification" in window) || Notification.permission !== "granted") { return; }
    try { new Notification("Wallhack", { body: message }); } catch (e) { /* some mobile browsers only allow service-worker notifications */ }
  }

  function pushAlert(message, simulated) {
    var list = $("mAlerts");
    if (!alerts) { list.textContent = ""; }
    alerts += 1;
    var li = document.createElement("li");
    li.appendChild(el("time", "", new Date().toLocaleTimeString()));
    li.appendChild(document.createTextNode(" " + message + (simulated ? " (simulated)" : "")));
    list.insertBefore(li, list.firstChild);
    while (list.children.length > MAX_ALERTS) { list.removeChild(list.lastChild); }
    notify(message);
  }

  function render(st) {
    var simulated = st.source === "simulator";
    $("mSim").hidden = !simulated;
    var badge = $("mBadge");
    badge.className = "badge " + (st.motion ? "moving" : (st.presence ? "present" : "idle"));
    badge.textContent = st.motion ? "Motion" : (st.presence ? "Present" : "No presence");
    $("mPresence").className = "pill " + (st.presence ? "on" : "off");
    $("mMotion").className = "pill " + (st.motion ? "on" : "off");
    $("mSub").textContent = st.note || "";
    var v = st.vitals || {};
    $("mBreath").textContent = fmt(v.breathing_bpm); $("mHeart").textContent = fmt(v.heart_bpm);
    var act = v.activity || "empty";
    $("mActivity").textContent = act; $("mActivity").className = "act " + act;
    var env = st.environment && st.environment.status, grid = $("mEnv");
    grid.textContent = "";
    METRICS.forEach(function (m) {
      var s = env && env[m[0]];
      if (!s) { return; }
      var card = el("div", "home-card " + String(s.status).toLowerCase(), "");
      card.appendChild(el("div", "label", m[1]));
      card.appendChild(el("div", "val", fmt(s.value) + (s.unit ? " " + s.unit : "")));
      card.appendChild(el("div", "status", s.status));
      grid.appendChild(card);
    });
    $("mEnvNote").textContent = env ? (st.environment.simulated ? "SIMULATED sensor values." : "") : "No environment sensors. Start Wallhack with --sensors.";
    var msg = alertFor(prev, st);
    if (msg) { pushAlert(msg, simulated); }
    prev = { presence: st.presence, motion: st.motion };
  }

  function enableNotifications() {
    if (!("Notification" in window)) { $("mNotifyNote").textContent = NOTE_NO_API; return; }
    if (!window.isSecureContext) { $("mNotifyNote").textContent = NOTE_INSECURE; }
    Notification.requestPermission().then(function (p) {
      $("mNotifyNote").textContent = p === "granted" ? "Notifications on while this page is open." : "Notifications are " + p + ". Alerts still appear below.";
    });
  }

  function poll() {
    if (document.hidden) { return; }
    Common.getJson("/api/status").then(function (st) { setConn("live", "ok"); render(st); })
      .catch(function () { setConn("offline", "error"); });
  }

  function init() {
    $("mNotify").addEventListener("click", enableNotifications);
    if (window.WALLHACK_DEMO) {
      window.WALLHACK_DEMO.play(function (frame) { render(frame.status); }, function () { prev = null; }, setConn);
    } else { poll(); setInterval(poll, POLL_MS); }
  }
  init();
})();
