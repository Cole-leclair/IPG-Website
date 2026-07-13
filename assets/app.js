// ---- Dev auto-reload (localhost only; no-op on the live site) ----
(function () {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  var watched = [location.pathname];
  document.querySelectorAll('link[rel="stylesheet"][href], script[src]').forEach(function (el) {
    var u = el.getAttribute("href") || el.getAttribute("src");
    if (u && u.indexOf("http") !== 0) watched.push(u.split("?")[0]);
  });
  var last = {};
  function poll() {
    Promise.all(watched.map(function (u) {
      return fetch(u, { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (t) { return [u, t]; }).catch(function () { return [u, null]; });
    })).then(function (results) {
      var changed = false;
      results.forEach(function (pair) {
        var u = pair[0], t = pair[1];
        if (t === null) return;
        if (last[u] !== undefined && last[u] !== t) changed = true;
        last[u] = t;
      });
      if (changed) location.reload();
    });
  }
  poll();
  setInterval(poll, 1000);
})();

(function () {
  "use strict";
  // ---- Mobile menu ----
  var toggle = document.getElementById("menuToggle");
  var links = document.getElementById("navLinks");
  if (toggle && links) {
    // The open-state styles live in styles.css (.nav-links.open) so the menu
    // uses the site palette instead of colors hardcoded here.
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  // ---- Reveal on scroll ----
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.15 });
    document.querySelectorAll(".reveal:not(.in)").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".reveal").forEach(function (el) { el.classList.add("in"); });
  }
// Demo mode = opened as a local file or served from localhost (offline
// mockup / preview). On the real Netlify domain, submissions POST for real.
var DEMO = location.protocol === "file:" ||
           location.hostname === "localhost" ||
           location.hostname === "127.0.0.1" ||
           location.hostname === "";
  function encode(data) {
    return Object.keys(data).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(data[k]);
    }).join("&");
  }
  function wireForm(formId, successId) {
    var f = document.getElementById(formId);
    if (!f) return;
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!f.checkValidity()) { f.reportValidity(); return; }
      var success = document.getElementById(successId);
      function showSuccess() { if (success) success.classList.add("show"); f.reset(); }
      if (DEMO) { showSuccess(); return; }
      var btn = f.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Sending…"; }
      var opts;
      if (f.querySelector('input[type="file"]')) {
        // multipart so any attached files (census / declaration pages) upload
        opts = { method: "POST", body: new FormData(f) };
      } else {
        var data = {};
        new FormData(f).forEach(function (v, k) { data[k] = v; });
        opts = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: encode(data) };
      }
      fetch("/", opts).then(function (res) {
        if (!res.ok) throw new Error("status " + res.status);
        showSuccess();
      }).catch(function () {
        window.alert("Sorry — something went wrong sending that. Please call (214) 377-1460 or email Cole@ipg.team and we’ll take care of it.");
      }).finally(function () {
        if (btn) { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
      });
    });
  }
  wireForm("quoteForm", "formSuccess");
  wireForm("heroForm", "heroFormSuccess");
  wireForm("personalQuoteForm", "personalFormSuccess");
  wireForm("businessQuoteForm", "businessFormSuccess");
  wireForm("benefitsQuoteForm", "benefitsFormSuccess");
  wireForm("certForm", "certFormSuccess");
  wireForm("claimForm", "claimFormSuccess");
  wireForm("payForm", "payFormSuccess");
  wireForm("changeForm", "changeFormSuccess");
  var serviceTabs = document.querySelectorAll(".service-tab");
  serviceTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var task = tab.dataset.task;
      var wasActive = tab.classList.contains("active");
      document.querySelectorAll(".service-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".service-form").forEach(function (f) { f.classList.remove("active"); });
      if (!wasActive) {
        tab.classList.add("active");
        var shown = document.querySelector('.service-form[data-form="' + task + '"]');
        if (shown) { shown.classList.add("active"); shown.scrollIntoView({ behavior: "smooth", block: "center" }); }
      }
    });
  });
  // Deep link into a service form: /service-center/#claim, #pay, #coi, #change
  // (used by the Business page's "Request a certificate" button, and shareable).
  if (serviceTabs.length) {
    var svcHash = (location.hash || "").replace("#", "");
    var svcTarget = svcHash && document.querySelector('.service-tab[data-task="' + svcHash + '"]');
    if (svcTarget) svcTarget.click();
  }

  document.querySelectorAll("[data-scroll-to]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      var target = document.getElementById(el.dataset.scrollTo);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ---------- Business: scenario tabs ----------
  var bizScenarios = [
    { chip: "WC", title: "A sub falls off a ladder", scenario: "A subcontractor is injured on your job site.", solution: "Workers\u2019 comp covers the claim; general liability covers damage to the property." },
    { chip: "GL", title: "A customer slips and falls", scenario: "A customer slips on a wet floor in your store.", solution: "General liability covers the claim \u2014 and a BOP bundles it with your building coverage." },
    { chip: "BOP", title: "A tenant\u2019s guest is hurt", scenario: "Someone is injured in a common area you\u2019re responsible for.", solution: "Your BOP\u2019s liability coverage responds, not your personal policy." },
    { chip: "E&O", title: "A client blames your advice", scenario: "A client claims your advice cost them money.", solution: "Professional / E&O coverage pays for defense and damages." },
    { chip: "CYBER", title: "A vendor exposes your client list", scenario: "A third-party data breach exposes your customer records.", solution: "Cyber liability covers notification costs and the fallout." },
    { chip: "BOP", title: "A kitchen fire shuts down service", scenario: "A grease fire damages the kitchen and forces you to close for repairs.", solution: "Your BOP covers the property damage and the income you lose while you rebuild." }
  ];
  var bizPanel = document.getElementById("bizPanel");
  function renderBiz(i) {
    var b = bizScenarios[i];
    bizPanel.innerHTML =
      '<span class="code-chip">' + b.chip + '</span>' +
      '<div><h3>' + b.title + '</h3>' +
      '<p class="scenario">\u201c' + b.scenario + '\u201d</p>' +
      '<p class="solution">' + b.solution + '</p></div>';
  }
  var bizTabs = document.querySelectorAll(".biz-tab");
  if (bizTabs.length && bizPanel) {
    renderBiz(0);
    bizTabs.forEach(function (t) {
      t.addEventListener("click", function () {
        bizTabs.forEach(function (o) { o.classList.remove("active"); });
        t.classList.add("active");
        renderBiz(Number(t.dataset.biz));
      });
    });
  }

  // ---------- Benefits: package builder ----------
  var pkgItems = [
    { id: "health", label: "Group Health", chip: "GRP", blurb: "Medical coverage for your team." },
    { id: "dental", label: "Dental & Vision", chip: "D&V", blurb: "Routine care that keeps small problems small." },
    { id: "life", label: "Group Life", chip: "LIFE", blurb: "A baseline safety net for every employee." },
    { id: "disability", label: "Disability", chip: "DI", blurb: "Income protection if someone can\u2019t work." },
    { id: "voluntary", label: "Voluntary Benefits", chip: "VOL", blurb: "Extra options employees can opt into and pay for themselves." }
  ];
  var pkgState = pkgItems.map(function () { return false; });
  var pkgOptionsEl = document.getElementById("pkgOptions");
  var pkgSummaryEl = document.getElementById("pkgSummaryBody");
  function renderPkgOptions() {
    pkgOptionsEl.innerHTML = pkgItems.map(function (item, i) {
      return '<button type="button" class="pkg-option' + (pkgState[i] ? ' on' : '') + '" data-pkg="' + i + '">' +
        '<span class="pkg-text"><h4>' + item.label + '</h4><p>' + item.blurb + '</p></span>' +
        '<span class="pkg-toggle" aria-hidden="true"></span></button>';
    }).join('');
    pkgOptionsEl.querySelectorAll(".pkg-option").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var i = Number(btn.dataset.pkg);
        pkgState[i] = !pkgState[i];
        renderPkgOptions();
        renderPkgSummary();
      });
    });
  }
  function renderPkgSummary() {
    var selected = pkgItems.filter(function (_, i) { return pkgState[i]; });
    if (!selected.length) {
      pkgSummaryEl.innerHTML = '<p class="pkg-empty">Nothing selected yet \u2014 toggle an option to start building.</p>';
      return;
    }
    pkgSummaryEl.innerHTML = '<ul>' + selected.map(function (item) {
      return '<li><span>' + item.label + '</span><span class="tag">' + item.chip + '</span></li>';
    }).join('') + '</ul>' +
      '<button type="button" class="btn pkg-cta" id="pkgSubmit">Request This Package</button>' +
      '<p class="pkg-cta-note">We\u2019ll turn your selections into real numbers.</p>';
    var submitBtn = document.getElementById("pkgSubmit");
    submitBtn.addEventListener("click", function () {
      var labels = selected.map(function (item) { return item.label; }).join(", ");
      var msgField = document.getElementById("beqMsg");
      if (msgField) msgField.value = "I'd like a benefits package quote for: " + labels + ".";
      var form = document.getElementById("benefitsQuoteForm");
      if (form) {
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        var nameField = document.getElementById("beqName");
        if (nameField) window.setTimeout(function () { nameField.focus(); }, 600);
      }
    });
  }
  if (pkgOptionsEl && pkgSummaryEl) {
    renderPkgOptions();
    renderPkgSummary();
  }

  // ---------- File upload: show chosen filename next to the button ----------
  document.querySelectorAll(".upload-row[data-group]").forEach(function (row) {
    var group = row.getAttribute("data-group");
    var inputs = [group, group + "-2", group + "-3", group + "-4", group + "-5"]
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
    var addBtns = row.querySelectorAll(".upload-btn.add");
    var namesEl = document.getElementById(group + "-names");
    function refresh() {
      var filled = 0;
      if (namesEl) namesEl.innerHTML = "";
      inputs.forEach(function (inp) {
        if (!(inp.files && inp.files.length)) return;
        filled++;
        if (!namesEl) return;
        var li = document.createElement("li");
        var name = document.createElement("span");
        name.className = "upload-fname";
        name.textContent = inp.files[0].name;
        var x = document.createElement("button");
        x.type = "button";
        x.className = "upload-remove";
        x.setAttribute("aria-label", "Remove " + inp.files[0].name);
        x.innerHTML = "&times;";
        x.addEventListener("click", function () { inp.value = ""; refresh(); });
        li.appendChild(name);
        li.appendChild(x);
        namesEl.appendChild(li);
      });
      addBtns.forEach(function (b, i) { b.hidden = filled < (i + 1); });
    }
    inputs.forEach(function (inp) { inp.addEventListener("change", refresh); });
  });

  // ---------- Home: live Google reviews ----------
  var gGrid = document.getElementById("reviewsGrid");
  if (gGrid && !DEMO) {
    var G_MARK = '<svg class="g-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/><path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/><path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/></svg>';
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
    var starRow = function (n) { var f = Math.round(n || 0), o = ""; for (var i = 0; i < 5; i++) o += (i < f ? "★" : "☆"); return o; };
    var clamp = function (t) { t = String(t || ""); return t.length > 320 ? t.slice(0, 300).replace(/\s+\S*$/, "") + "…" : t; };
    fetch("/.netlify/functions/reviews", { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.configured) return;
        var scoreEl = document.getElementById("gScore"),
            countEl = document.getElementById("gCount"),
            starsEl = document.getElementById("gStars"),
            ctaEl = document.getElementById("reviewsCta");
        if (data.rating != null && scoreEl) scoreEl.textContent = Number(data.rating).toFixed(1);
        if (data.rating != null && starsEl) starsEl.textContent = starRow(data.rating);
        if (data.total != null && countEl) countEl.textContent = data.total + " Google review" + (data.total === 1 ? "" : "s");
        if (data.url && ctaEl) ctaEl.setAttribute("href", data.url);
        if (data.reviews && data.reviews.length) {
          var palette = ["#5E9CEA", "#E0803C", "#57A05A", "#9B59B6", "#E05C6E"];
          gGrid.innerHTML = data.reviews.slice(0, 6).map(function (rv, i) {
            var initial = esc((rv.name || "G").trim().charAt(0).toUpperCase());
            return '<div class="review-card">' +
              '<div class="review-top">' +
              '<span class="review-avatar" style="background:' + palette[i % palette.length] + ';">' + initial + '</span>' +
              '<span class="review-who"><span class="name">' + esc(rv.name || "Google user") + '</span>' +
              '<span class="when">' + esc(rv.when || "") + '</span></span>' +
              G_MARK +
              '</div>' +
              '<div class="review-stars">' + starRow(rv.rating) + '</div>' +
              '<p class="quote">' + esc(clamp(rv.text)) + '</p>' +
              '</div>';
          }).join("");
          gGrid.style.display = "grid";
        }
      })
      .catch(function () {});
  }
})();
