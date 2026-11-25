"use strict";
// Shared by the dashboard, the mobile companion and the judge page: demo-aware JSON loading, the
// graphics quality setting (low, medium, high) and a seeded ambient particle layer behind the page.
// Low quality draws no particles and turns off blur and animation in style.css; prefers-reduced-motion
// draws a single still frame. Nothing here loads from the network except same-origin JSON.
(function (root) {
  var LEVELS = ["low", "medium", "high"], DEFAULT = "medium";
  var PARTICLES = { low: 0, medium: 26, high: 64 };
  var FX_SEED = 0xA3B17, SLOW_FRAME_MS = 40, FRAME_SAMPLES = 45, WARMUP_FRAMES = 20, FRAME_CAP_MS = 33;
  var DRIFT = 0.012, DOT_MIN = 1, DOT_SPAN = 2.2, ALPHA = 0.5;
  var TWO_PI = Math.PI * 2, UINT32 = 4294967296;

  function normalise(q) { return LEVELS.indexOf(q) >= 0 ? q : DEFAULT; }
  // Particles to draw: none on low quality, and only a still frame is drawn when motion is reduced.
  function particleCount(quality) { return PARTICLES[normalise(quality)]; }

  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32;
    };
  }

  // Positions are fractions of the page, identical on every run.
  function particles(count) {
    var rnd = seeded(FX_SEED), list = [];
    for (var i = 0; i < count; i++) {
      list.push({ x: rnd(), y: rnd(), size: DOT_MIN + rnd() * DOT_SPAN, speed: 0.4 + rnd(), phase: rnd() * TWO_PI });
    }
    return list;
  }

  var api = { normalise: normalise, particleCount: particleCount, particles: particles, LEVELS: LEVELS };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!root || !root.document) { return; }

  var DEMO = function () { return root.WALLHACK_DEMO || null; };
  api.getJson = function (url) {
    var demo = DEMO();
    if (demo) { return demo.getJson(url); }
    return root.fetch(url).then(function (r) {
      if (!r.ok) { throw new Error(url + " returned " + r.status); }
      return r.json();
    });
  };

  // Page links: the live server routes /mobile and /judge, the static demo serves plain files.
  api.href = function (h) {
    if (!DEMO()) { return h; }
    if (h === "/mobile") { return "mobile.html"; }
    if (h === "/judge") { return "judge.html"; }
    if (h === "/planner") { return "planner.html"; }
    return "index.html" + (h.indexOf("#") >= 0 ? h.slice(h.indexOf("#")) : "");
  };
  function fixLinks() {
    Array.prototype.forEach.call(root.document.querySelectorAll("a[data-page]"), function (a) {
      a.setAttribute("href", api.href(a.getAttribute("data-page")));
    });
  }

  var quality = DEFAULT, list = [], canvas = null, ctx = null, running = false, reduced = false;
  var frameTimes = [], seen = 0, lastFrame = 0, lastDraw = 0;
  try { quality = normalise(root.localStorage.getItem("wallhack.quality")); } catch (e) { /* storage unavailable */ }
  root.document.documentElement.setAttribute("data-quality", quality);

  function color() { return getComputedStyle(root.document.documentElement).getPropertyValue("--accent").trim() || "#2dd4bf"; }

  function draw(tSec) {
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color();
    list.forEach(function (p) {
      var y = (p.y - (tSec * DRIFT * p.speed)) % 1;
      if (y < 0) { y += 1; }
      var x = p.x + Math.sin(tSec * 0.3 * p.speed + p.phase) * 0.01;
      ctx.globalAlpha = ALPHA * (0.4 + 0.6 * Math.sin(tSec * p.speed + p.phase) * Math.sin(tSec * p.speed + p.phase));
      ctx.beginPath(); ctx.arc(x * w, y * h, p.size, 0, TWO_PI); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function size() {
    canvas.width = Math.max(1, root.innerWidth); canvas.height = Math.max(1, root.innerHeight);
  }

  function frame(now) {
    if (!running) { return; }
    root.requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_CAP_MS) { return; }
    if (lastFrame && ++seen > WARMUP_FRAMES) {
      frameTimes.push(now - lastFrame);
      if (frameTimes.length >= FRAME_SAMPLES) {
        var sum = 0;
        frameTimes.forEach(function (v) { sum += v; });
        frameTimes = [];
        if (sum / FRAME_SAMPLES > SLOW_FRAME_MS) { api.setQuality("low"); return; }   // auto-drop, not saved
      }
    }
    lastFrame = now; lastDraw = now;
    draw(now / 1000);
  }

  function restart() {
    running = false;
    if (canvas) { canvas.hidden = true; }
    var count = particleCount(quality);
    if (!count) { return; }
    if (!canvas) {
      canvas = root.document.createElement("canvas");
      canvas.id = "fx"; canvas.setAttribute("aria-hidden", "true");
      root.document.body.insertBefore(canvas, root.document.body.firstChild);
      ctx = canvas.getContext("2d");
      root.addEventListener("resize", function () { if (!canvas.hidden) { size(); if (reduced) { draw(0); } } });
    }
    canvas.hidden = false; size(); list = particles(count); frameTimes = []; seen = 0; lastFrame = 0;
    if (reduced) { draw(0); return; }
    running = true; root.requestAnimationFrame(frame);
  }

  api.getQuality = function () { return quality; };
  api.setQuality = function (q) {
    quality = normalise(q);
    root.document.documentElement.setAttribute("data-quality", quality);
    restart();
  };

  // Front-end error boundary: an uncaught error or rejected promise is shown in a live region instead of failing silently.
  // The page's own notice element is reused when it exists (planner: #plannerNotice, dashboard: #note).
  var ERROR_REGION_IDS = ["plannerNotice", "note"], ERROR_ELEMENT_ID = "errorBoundary", MAX_ERROR_TEXT = 300;
  api.errorMessage = function (reason) {
    var text = reason && reason.message ? reason.message : String(reason);
    return "Something went wrong: " + text.slice(0, MAX_ERROR_TEXT) + ". Your saved data is untouched. Reload the page if this keeps happening.";
  };
  api.reportError = function (reason) {
    var doc = root.document, el = null;
    ERROR_REGION_IDS.forEach(function (id) { el = el || doc.getElementById(id); });
    if (!el) {
      el = doc.getElementById(ERROR_ELEMENT_ID);
      if (!el) { el = doc.createElement("div"); el.id = ERROR_ELEMENT_ID; el.className = "banner error"; doc.body.insertBefore(el, doc.body.firstChild); }
    }
    el.hidden = false; el.className = "banner error"; el.setAttribute("role", "alert");
    el.textContent = api.errorMessage(reason);
  };
  root.addEventListener("error", function (e) { api.reportError(e.error || e.message); });
  root.addEventListener("unhandledrejection", function (e) { api.reportError(e.reason); });

  root.WallhackCommon = api;
  root.document.addEventListener("DOMContentLoaded", function () {
    var mq = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
    reduced = !!(mq && mq.matches);
    if (mq && mq.addEventListener) { mq.addEventListener("change", function (e) { reduced = e.matches; restart(); }); }
    root.document.addEventListener("visibilitychange", function () {
      if (root.document.hidden) { running = false; } else if (canvas && !canvas.hidden && !reduced) { running = true; root.requestAnimationFrame(frame); }
    });
    fixLinks(); restart();
  });
})(typeof window !== "undefined" ? window : null);
