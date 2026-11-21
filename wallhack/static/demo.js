"use strict";
// Static demo support: replays a recording made by tools/build_demo.py from the real Python
// pipeline. It only exists in the built demo site; the live dashboard never loads this file.
(function () {
  var state = { data: null, frame: 0, timer: null, paused: false };
  var sinks = null;

  function banner() {
    var el = document.createElement("div");
    el.id = "demoBanner"; el.className = "banner demo"; el.setAttribute("role", "note");
    var p = document.createElement("p");
    var b = document.createElement("strong");
    b.textContent = "Simulated replay. Not live sensing. Nothing here reads your WiFi.";
    p.appendChild(b);
    p.appendChild(document.createTextNode(" Everything shown was recorded from the Wallhack simulator. Settings are read-only. Run Wallhack locally for live sensing."));
    var btn = document.createElement("button");
    btn.id = "demoPause"; btn.type = "button"; btn.textContent = "Pause";
    btn.addEventListener("click", function () {
      state.paused = !state.paused; btn.textContent = state.paused ? "Play" : "Pause";
      if (sinks) { sinks.conn(state.paused ? "demo paused" : "demo replay", "ok"); }
    });
    el.appendChild(p);
    if (!document.body.classList.contains("page-judge") && !document.body.classList.contains("page-planner")) { el.appendChild(btn); }   // the judge page has no replay to pause
    document.body.insertBefore(el, document.body.firstChild);
  }
  document.addEventListener("DOMContentLoaded", banner);

  function loadRecording() {
    if (!state.data) {
      state.data = fetch("recording.json").then(function (r) {
        if (!r.ok) { throw new Error("recording.json returned " + r.status); }
        return r.json();
      });
    }
    return state.data;
  }

  // REST path -> recorded file. The live API serves the same shapes.
  var FILES = { "/api/twin": "twin.json", "/api/history": "history.json", "/api/insights": "insights.json",
                "/api/scores": "scores.json", "/api/health": "health.json", "/api/game/scenario": "scenario.json",
                "/api/rf/coverage": "coverage.json", "/api/judge": "judge.json" };
  var files = {};

  function loadFile(name) {
    if (!files[name]) {
      files[name] = fetch(name).then(function (r) {
        if (!r.ok) { throw new Error(name + " returned " + r.status); }
        return r.json();
      });
    }
    return files[name];
  }

  function current() { return loadRecording().then(function (d) { return d.frames[state.frame] || d.frames[0]; }); }

  window.WALLHACK_DEMO = {
    // Serves the REST endpoints app.js reads from the recording.
    getJson: function (url) {
      var path = url.split("?")[0];
      if (path === "/api/settings") { return loadRecording().then(function (d) { return d.settings; }); }
      if (path === "/api/status") { return current().then(function (f) { return f.status; }); }
      if (path === "/api/events") { return current().then(function (f) { return f.events; }); }
      if (path === "/api/rf/coverage") {
        var m = /[?&]floor=([^&]+)/.exec(url);
        return loadFile(FILES[path]).then(function (all) {
          var key = m ? decodeURIComponent(m[1]) : Object.keys(all)[0];
          if (!all[key]) { throw new Error("unknown floor " + key); }
          return all[key];
        });
      }
      if (FILES[path]) { return loadFile(FILES[path]); }
      return Promise.reject(new Error("not available in the static demo: " + path));
    },
    // Plays frames at the recorded tick rate and restarts the client state on each loop, because
    // sample numbering and the sensing baselines restart with the recording.
    play: function (ingest, reset, setConn) {
      sinks = { conn: setConn };
      loadRecording().then(function (d) {
        setConn("demo replay", "ok");
        state.timer = setInterval(function () {
          if (state.paused) { return; }
          if (state.frame >= d.frames.length) { state.frame = 0; reset(); }
          ingest(d.frames[state.frame]);
          state.frame += 1;
        }, d.meta.tick_s * 1000);
      }).catch(function (e) { setConn("demo failed", "warn"); throw e; });
    },
    readOnlyMessage: "Demo replay: settings are read-only. Run Wallhack locally to change them or calibrate."
  };
})();
