"use strict";
// Judge mode: renders /api/judge (wallhack/judge.py), which tests keep consistent with the README
// verification table. The page adds no claims of its own.
(function () {
  var Common = window.WallhackCommon;
  // Status shapes are drawn with CSS (.judge-icon.is-*) so they do not depend on installed symbol fonts.
  function markIcon(status) {
    var icon = document.createElement("span");
    icon.className = "judge-icon is-" + status.toLowerCase(); icon.setAttribute("aria-hidden", "true");
    return icon;
  }
  var VERIFICATION_LISTS = { "VERIFIED": "jVerified", "PARTIALLY VERIFIED": "jPartial", "UNVERIFIED": "jUnverified", "NOT BUILT": "jUnbuilt" };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, str) { var e = document.createElement(tag); if (cls) { e.className = cls; } e.textContent = str; return e; }

  function render(data) {
    var legend = $("jLegend"), items = $("jItems");
    data.statuses.forEach(function (s) {
      var n = data.items.filter(function (i) { return i.status === s; }).length;
      var chip = el("span", "chip st-" + s.toLowerCase(), " " + s + " (" + n + ")");
      chip.insertBefore(markIcon(s), chip.firstChild);
      legend.appendChild(chip);
    });
    data.items.forEach(function (i) {
      var li = el("li", "judge-item st-" + i.status.toLowerCase(), "");
      var mark = el("span", "judge-mark", "");
      mark.appendChild(markIcon(i.status));   // decorative (aria-hidden): the status text chip carries the meaning
      li.appendChild(mark);
      var body = el("div", "", "");
      var head = el("div", "judge-head", "");
      var title = i.link ? el("a", "", i.title) : el("strong", "", i.title);
      if (i.link) { title.setAttribute("href", Common.href(i.link)); title.setAttribute("data-page", i.link); }
      head.appendChild(title);
      head.appendChild(el("span", "chip st-" + i.status.toLowerCase(), i.status));
      head.appendChild(el("span", "chip", i.verification));
      body.appendChild(head); body.appendChild(el("div", "muted", i.detail));
      li.appendChild(body); items.appendChild(li);
      var target = $(VERIFICATION_LISTS[i.verification]);
      if (target) { target.appendChild(el("li", "", i.title)); }
    });
    data.modes.forEach(function (m) {
      var li = document.createElement("li"), a = el("a", "", m.label);
      a.setAttribute("href", Common.href(m.href)); li.appendChild(a); $("jModes").appendChild(li);
    });
    $("jNote").textContent = data.note;
  }

  Common.getJson("/api/judge").then(render).catch(function (e) { $("jNote").textContent = "Could not load the status list: " + e.message; });
})();
