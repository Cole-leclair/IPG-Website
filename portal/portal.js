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

  // =====================================================================
  // CONFIG — flip the portal from PREVIEW MODE to live auth.
  // =====================================================================
  var PORTAL_CONFIG = {
    // TODO(Clerk): paste your Clerk publishable key here (Phase 1). While this
    // is empty the portal runs in PREVIEW MODE: a mock login, no real backend.
    clerkPublishableKey: "",
    // Base path for the portal API (Netlify functions). Used in Phase 2 when
    // the PortalData getters below start calling real endpoints.
    apiBase: "/.netlify/functions"
  };
  var PREVIEW_MODE = !PORTAL_CONFIG.clerkPublishableKey;

  // PREVIEW ONLY: which mock dataset to show. In production the account type is
  // NOT chosen here — it comes from Bindly (via Clerk metadata). This just lets
  // us demo both experiences: add ?demo=commercial (or ?demo=personal) to the URL.
  function previewType() {
    var m = /[?&](?:demo|type)=(commercial|personal)/.exec(location.search);
    return m ? m[1] : "personal";
  }

  // =====================================================================
  // DATA LAYER — the only place that talks to "the backend".
  // Today it returns mock data, split by account type (personal vs
  // commercial). To go live, replace each function body with a real call
  // to Bindly's API (through a Netlify function that holds the API key
  // server-side). The UI below never has to change.
  //
  // Personal clients see homeowners/auto/umbrella-style policies, their
  // documents, and their account. Commercial clients additionally get the
  // Certificates tab + COI request flow, and a company on their profile.
  // =====================================================================

  // TODO(Bindly): the real client "type" comes from the Bindly client
  // record, not from a login toggle. Once auth is wired, map the signed-in
  // user -> Bindly client id -> client.type and ignore the UI hint.
  var MOCK = {
    personal: {
      client: { name: "Jordan Rivera", company: "", type: "personal" },
      policies: [
        { type: "Homeowners", number: "HO-4471902", carrier: "Travelers", term: "Feb 2026 – Feb 2027", status: "active" },
        { type: "Personal Auto", number: "PA-8830115", carrier: "Progressive", term: "Jan 2026 – Jul 2026", status: "active", renewsSoon: true },
        { type: "Personal Umbrella", number: "UMB-220417", carrier: "Chubb", term: "Feb 2026 – Feb 2027", status: "active" },
        { type: "Valuable Articles", number: "VA-100338", carrier: "Chubb", term: "Feb 2026 – Feb 2027", status: "active" }
      ],
      documents: [
        { name: "Homeowners Policy — 2026.pdf", kind: "Policy", date: "Jan 12, 2026", url: "#" },
        { name: "Auto ID Cards.pdf", kind: "ID Cards", date: "Jan 12, 2026", url: "#" },
        { name: "Home Declaration Page.pdf", kind: "Declaration", date: "Jan 12, 2026", url: "#" },
        { name: "Umbrella Policy — 2026.pdf", kind: "Policy", date: "Feb 2, 2026", url: "#" }
      ],
      holders: [],
      account: {
        name: "Jordan Rivera", company: "",
        email: "jordan.rivera@example.com", phone: "(214) 555-0148",
        address: "4820 Cole Ave, Dallas, TX 75205",
        contacts: [
          { id: "c-1", name: "Alex Rivera", role: "Spouse", email: "alex.rivera@example.com", phone: "(214) 555-0149" }
        ]
      }
    },
    commercial: {
      client: { name: "Maria Delgado", company: "Acme Roofing LLC", type: "commercial" },
      policies: [
        { type: "General Liability", number: "GL-7781204", carrier: "The Hartford", term: "Mar 2026 – Mar 2027", status: "active" },
        { type: "Commercial Property", number: "CP-4419077", carrier: "Travelers", term: "Mar 2026 – Mar 2027", status: "active" },
        { type: "Workers' Compensation", number: "WC-6620913", carrier: "AmTrust", term: "Jan 2026 – Jan 2027", status: "active" },
        { type: "Commercial Auto", number: "CA-5530188", carrier: "Progressive Commercial", term: "Mar 2026 – Mar 2027", status: "active" },
        { type: "Commercial Umbrella", number: "UMB-330820", carrier: "Chubb", term: "Mar 2026 – Mar 2027", status: "active" }
      ],
      documents: [
        { name: "General Liability Policy — 2026.pdf", kind: "Policy", date: "Feb 20, 2026", url: "#" },
        { name: "Property Declaration Page.pdf", kind: "Declaration", date: "Feb 20, 2026", url: "#" },
        { name: "Workers Comp Policy — 2026.pdf", kind: "Policy", date: "Jan 8, 2026", url: "#" },
        { name: "Commercial Auto ID Cards.pdf", kind: "ID Cards", date: "Feb 20, 2026", url: "#" },
        { name: "Loss Runs — 2025.pdf", kind: "Loss Runs", date: "Jan 6, 2026", url: "#" }
      ],
      holders: [
        { id: "h-1", name: "ABC Property Management", address: "500 N Akard St, Dallas, TX 75201", status: "issued", date: "Mar 3, 2026", url: "#" },
        { id: "h-2", name: "City of Dallas", address: "1500 Marilla St, Dallas, TX 75201", status: "issued", date: "Feb 18, 2026", url: "#" }
      ],
      account: {
        name: "Maria Delgado", company: "Acme Roofing LLC",
        email: "maria@acmeroofing.com", phone: "(214) 555-0192",
        address: "1200 Commerce St, Suite 400, Dallas, TX 75202",
        contacts: [
          { id: "c-1", name: "Dana Ortiz", role: "Billing", email: "dana@acmeroofing.com", phone: "(214) 555-0193" },
          { id: "c-2", name: "Sam Ortiz", role: "Safety Manager", email: "sam@acmeroofing.com", phone: "(214) 555-0194" }
        ]
      }
    }
  };

  var PortalData = {
    _type: "personal", // set at login; drives which dataset the getters return

    // TODO(Clerk/Bindly): in production, auth is handled by Clerk (see initAuth
    // below) and this method goes away — the signed-in user's client id +
    // account_type come from Clerk metadata (sourced from the Bindly client
    // record), never from anything the browser chooses. This mock stands in
    // until Phase 1 lands; the type is read from the ?demo= preview param.
    login: function (email, password) {
      var self = this;
      return new Promise(function (resolve) {
        setTimeout(function () {
          self._type = previewType();
          resolve({ ok: true, client: MOCK[self._type].client });
        }, 350);
      });
    },
    // TODO(Bindly): GET this client's documents. Shape: [{name, kind, date, url}]
    getDocuments: function () { return Promise.resolve(MOCK[this._type].documents.slice()); },
    // TODO(Bindly): GET this client's policies. Shape: [{type, number, carrier, term, status}]
    getPolicies: function () { return Promise.resolve(MOCK[this._type].policies.slice()); },
    // TODO(Bindly): GET the holders/certificates already on this master COI.
    // Shape: [{id, name, address, status, date, url}]
    getHolders: function () { return Promise.resolve((MOCK[this._type].holders || []).slice()); },
    // Self-service issue. Client only supplies name/address, so every holder
    // is standard coverage off the master COI — always issues INSTANTLY.
    // TODO(Bindly): call Bindly to generate the ACORD 25 from the master COI
    // and return a signed URL.
    addHolder: function (data) {
      return Promise.resolve({ ok: true, status: "issued", holder: {
        id: "h-" + Date.now(),
        name: data.name,
        address: data.address || "",
        status: "issued",
        date: "Just now",
        url: "#"
      }});
    },
    // TODO(Bindly): GET this client's account/profile details.
    getAccount: function () { return Promise.resolve(MOCK[this._type].account); },
    // TODO(Bindly): additional contacts stored on the client record — reference
    // only (billing/HR/etc.), not portal logins. Shape: [{id, name, role, email, phone}]
    getContacts: function () { return Promise.resolve((MOCK[this._type].account.contacts || []).slice()); },
    addContact: function (data) {
      var c = { id: "c-" + Date.now(), name: data.name, role: data.role || "", email: data.email || "", phone: data.phone || "" };
      MOCK[this._type].account.contacts.push(c);
      return Promise.resolve({ ok: true, contact: c });
    },
    updateContact: function (id, data) {
      var list = MOCK[this._type].account.contacts;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i] = { id: id, name: data.name, role: data.role || "", email: data.email || "", phone: data.phone || "" };
          return Promise.resolve({ ok: true, contact: list[i] });
        }
      }
      return Promise.resolve({ ok: false });
    },
    removeContact: function (id) {
      var list = MOCK[this._type].account.contacts;
      MOCK[this._type].account.contacts = list.filter(function (c) { return c.id !== id; });
      return Promise.resolve({ ok: true });
    },
    isCommercial: function () { return this._type === "commercial"; },
    logout: function () { return Promise.resolve(); }
  };

  // Local view state (mock). Holders added in-session live here.
  var state = { policies: [], holders: [], commercial: false, contacts: [] };

  // =====================================================================
  // Helpers + UI
  // =====================================================================
  var FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  var PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/></svg>';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var loginView = $("portalLogin");
  var appView = $("portalApp");
  var loginForm = $("loginForm");
  var loginMsg = $("loginMsg");

  function cleanDocName(name) {
    return (name || "").replace(/\s*[—-]\s*\d{4}(\.\w+)?$/, "").replace(/\.\w+$/, "");
  }
  function docItem(d) {
    return '<li><span class="doc-ico">' + FILE_ICON + '</span>' +
      '<span class="doc-meta"><span class="n">' + esc(cleanDocName(d.name)) + '</span>' +
      '<span class="m">' + esc(d.kind || "") + (d.date ? " · " + esc(d.date) : "") + '</span></span>' +
      '<a class="doc-dl" href="' + esc(d.url || "#") + '"' + (d.url && d.url !== "#" ? ' download' : '') + '>Download</a></li>';
  }
  function renderDocs(el, items, emptyText) {
    if (!el) return;
    el.innerHTML = (items && items.length)
      ? items.map(docItem).join("")
      : '<li class="doc-empty">' + esc(emptyText || "Nothing here yet.") + '</li>';
  }

  function statusBadge(status) {
    var map = { active: ["active", "Active"], received: ["pending", "Received"], "in review": ["pending", "In review"], issued: ["issued", "Issued"] };
    var m = map[status] || ["pending", status || ""];
    return '<span class="badge ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  function renderPolicies() {
    var el = $("policyList");
    if (!el) return;
    el.innerHTML = state.policies.length ? state.policies.map(function (p) {
      return '<li><span class="policy-info"><span class="n">' + esc(p.type) + '</span>' +
        '<span class="m">' + esc(p.carrier || "") + " · #" + esc(p.number || "") + " · " + esc(p.term || "") + '</span></span>' +
        statusBadge(p.status) + '</li>';
    }).join("") : '<li class="doc-empty">No policies on file.</li>';
  }

  function renderHolders() {
    var el = $("holderList");
    if (!el) return;
    el.innerHTML = state.holders.length ? state.holders.map(function (h) {
      var bits = [h.address, h.date].filter(Boolean);
      var dl = h.status === "issued"
        ? '<a class="doc-dl" href="' + esc(h.url || "#") + '"' + (h.url && h.url !== "#" ? ' download' : '') + '>Download</a>'
        : '';
      return '<li><span class="doc-ico">' + FILE_ICON + '</span>' +
        '<span class="doc-meta"><span class="n">' + esc(h.name) + '</span>' +
        '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
        statusBadge(h.status) + dl + '</li>';
    }).join("") : '<li class="doc-empty">No certificate holders yet.</li>';
  }

  function updateStats() {
    $("statPolicies").textContent = state.policies.length;
    var thirdCard = $("statThird").parentNode;
    if (state.commercial) {
      // Every holder issues instantly now — show the running certificate count.
      $("statThirdLbl").textContent = "Certificates issued";
      $("statThird").textContent = state.holders.length;
      thirdCard.setAttribute("data-goto", "certificates");
    } else {
      // Personal clients care about upcoming renewals instead.
      var soon = state.policies.filter(function (p) { return p.renewsSoon; }).length;
      $("statThirdLbl").textContent = "Renewing soon";
      $("statThird").textContent = soon;
      thirdCard.removeAttribute("data-goto");
    }
  }

  function renderAccount(a) {
    var el = $("acctGrid");
    if (!el || !a) return;
    var rows = [["Name", a.name]];
    if (a.company) rows.push(["Company", a.company]); // commercial only
    rows.push(["Email", a.email], ["Phone", a.phone], ["Mailing address", a.address]);
    el.innerHTML = rows.map(function (r) {
      return '<div class="acct-item"><div class="k">' + esc(r[0]) + '</div><div class="v">' + esc(r[1] || "—") + '</div></div>';
    }).join("");
  }

  function renderQuickActions() {
    var el = $("quickActions");
    if (!el) return;
    var actions = state.commercial
      ? [["Request a certificate", "certificates"], ["View documents", "documents"]]
      : [["View my ID cards", "documents"], ["Account & contacts", "account"]];
    el.innerHTML = actions.map(function (a) {
      return '<button class="btn btn-outline btn-sm" type="button" data-goto="' + a[1] + '">' + esc(a[0]) + '</button>';
    }).join("");
  }

  function renderContacts() {
    var el = $("contactList");
    if (!el) return;
    el.innerHTML = state.contacts.length ? state.contacts.map(function (c) {
      var bits = [c.role, c.email, c.phone].filter(Boolean);
      return '<li><span class="doc-ico">' + PERSON_ICON + '</span>' +
        '<span class="doc-meta"><span class="n">' + esc(c.name) + '</span>' +
        '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
        '<span class="contact-actions">' +
        '<a href="#" class="doc-dl" data-edit="' + esc(c.id) + '">Edit</a>' +
        '<a href="#" class="doc-dl doc-dl-danger" data-remove="' + esc(c.id) + '">Remove</a>' +
        '</span></li>';
    }).join("") : '<li class="doc-empty">No additional contacts yet.</li>';
  }

  // ---- Add / edit / remove account contacts ----
  function initContactForm() {
    var form = $("contactForm");
    if (!form) return;
    var list = $("contactList");
    var cancelBtn = $("contactCancelBtn");
    var submitBtn = $("contactSubmitBtn");

    function resetForm() {
      form.reset();
      $("cId").value = "";
      submitBtn.textContent = "Add contact";
      cancelBtn.hidden = true;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("contactMsg");
      msg.className = "portal-msg";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var id = $("cId").value;
      var data = { name: $("cName").value, role: $("cRole").value, email: $("cEmail").value, phone: $("cPhone").value };
      submitBtn.disabled = true;
      var call = id ? PortalData.updateContact(id, data) : PortalData.addContact(data);
      call.then(function (res) {
        if (res && res.ok) {
          if (id) {
            state.contacts = state.contacts.map(function (c) { return c.id === id ? res.contact : c; });
          } else {
            state.contacts.push(res.contact);
          }
          renderContacts();
          resetForm();
          msg.className = "portal-msg ok";
          msg.textContent = id ? "Contact updated." : "Contact added.";
        }
      }).finally(function () { submitBtn.disabled = false; });
    });

    cancelBtn.addEventListener("click", function () { resetForm(); $("contactMsg").textContent = ""; });

    if (list) {
      list.addEventListener("click", function (e) {
        var editId = e.target.getAttribute("data-edit");
        var removeId = e.target.getAttribute("data-remove");
        if (editId) {
          e.preventDefault();
          var c = state.contacts.filter(function (x) { return x.id === editId; })[0];
          if (!c) return;
          $("cId").value = c.id;
          $("cName").value = c.name || "";
          $("cRole").value = c.role || "";
          $("cEmail").value = c.email || "";
          $("cPhone").value = c.phone || "";
          submitBtn.textContent = "Save changes";
          cancelBtn.hidden = false;
          $("cName").focus();
        } else if (removeId) {
          e.preventDefault();
          if (!window.confirm("Remove this contact?")) return;
          PortalData.removeContact(removeId).then(function () {
            state.contacts = state.contacts.filter(function (c) { return c.id !== removeId; });
            renderContacts();
            if ($("cId").value === removeId) resetForm();
          });
        }
      });
    }
  }

  // ---- Placeholder downloads ----
  // Document/certificate URLs are "#" until the Bindly read API is wired.
  // Intercept those clicks so clients get an explanation instead of a silent
  // jump to the top of the page. Real signed URLs bypass this entirely.
  var toastEl = null, toastTimer = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "portal-toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 3200);
  }
  function initPlaceholderDownloads() {
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a.doc-dl") : null;
      if (!a || a.getAttribute("href") !== "#") return;
      // Contact Edit/Remove and error-retry links share the .doc-dl style —
      // leave them to their own handlers.
      if (a.hasAttribute("data-edit") || a.hasAttribute("data-remove") || a.hasAttribute("data-retry")) return;
      e.preventDefault();
      showToast("Downloads will be available once your account is connected to live data.");
    });
  }

  // ---- Tabs ----
  function activateTab(name) {
    document.querySelectorAll(".ptab").forEach(function (x) {
      x.classList.toggle("active", x.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".ptab-panel").forEach(function (p) {
      p.hidden = p.getAttribute("data-panel") !== name;
    });
    window.scrollTo(0, 0);
  }
  function initTabs() {
    document.querySelectorAll(".ptab").forEach(function (t) {
      t.addEventListener("click", function () { activateTab(t.getAttribute("data-tab")); });
    });
    // Stat cards and quick-action buttons deep-link into tabs.
    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-goto]") : null;
      if (el) activateTab(el.getAttribute("data-goto"));
    });
  }

  // ---- Add a certificate holder (self-service) ----
  function initHolderForm() {
    var form = $("holderForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("holderMsg");
      msg.className = "portal-msg";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var data = { name: $("hName").value, address: $("hAddr").value };
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
      PortalData.addHolder(data).then(function (res) {
        if (res && res.ok) {
          state.holders.unshift(res.holder);
          renderHolders(); updateStats();
          form.reset();
          msg.className = "portal-msg ok";
          msg.textContent = "Certificate issued — download it from the list below.";
        }
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Add holder"; }
      });
    });
  }

  // ---- Dashboard data (loading / loaded / failed) ----
  // The mock resolves instantly, but real Bindly-backed calls won't — and one
  // failed request must never leave a client staring at silently-empty panels.
  function setDashboardLoading() {
    ["policyList", "docList", "holderList", "contactList"].forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = '<li class="doc-empty">Loading…</li>';
    });
    var grid = $("acctGrid");
    if (grid) grid.innerHTML = '<div class="doc-empty">Loading…</div>';
    $("statPolicies").textContent = "—";
    $("statDocs").textContent = "—";
    $("statThird").textContent = "—";
  }
  function setDashboardError() {
    var retry = 'Couldn’t load this — <a href="#" class="doc-dl" data-retry>try again</a>.';
    ["policyList", "docList", "holderList", "contactList"].forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = '<li class="doc-empty">' + retry + '</li>';
    });
    var grid = $("acctGrid");
    if (grid) grid.innerHTML = '<div class="doc-empty">' + retry + '</div>';
  }
  function loadDashboard() {
    setDashboardLoading();
    Promise.all([
      PortalData.getPolicies(), PortalData.getDocuments(),
      PortalData.getHolders(), PortalData.getAccount(),
      PortalData.getContacts()
    ]).then(function (r) {
      state.policies = r[0] || [];
      state.holders = r[2] || [];
      state.contacts = r[4] || [];
      $("statDocs").textContent = (r[1] || []).length;
      renderPolicies();
      renderDocs($("docList"), r[1], "No documents on file yet.");
      renderHolders();
      renderAccount(r[3]);
      renderContacts();
      updateStats();
    }).catch(function () {
      setDashboardError();
    });
  }
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("[data-retry]") : null;
    if (!a) return;
    e.preventDefault();
    loadDashboard();
  });

  // ---- Session ----
  function showDashboard(client) {
    var commercial = client && client.type === "commercial";
    state.commercial = commercial;

    loginView.hidden = true;
    appView.hidden = false;

    // Header + greeting adapt to the client type.
    $("pUser").textContent = (client && (client.company || client.name)) || "Client";
    $("pWelcome").textContent = "Welcome, " + ((client && client.name) || "Client") + ".";
    $("pCompany").textContent = commercial && client.company ? client.company : "";

    // Certificates tab is commercial-only. Always start on Overview.
    var certTab = $("certTab");
    if (certTab) certTab.hidden = !commercial;
    activateTab("overview");

    renderQuickActions();
    loadDashboard();
    window.scrollTo(0, 0);
  }

  if (loginForm) {
    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      loginMsg.className = "portal-msg";
      loginMsg.textContent = "";
      if (!loginForm.checkValidity()) { loginForm.reportValidity(); return; }
      var btn = loginForm.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }
      PortalData.login($("plEmail").value, $("plPass").value).then(function (res) {
        if (res && res.ok) { showDashboard(res.client); }
        else { loginMsg.className = "portal-msg err"; loginMsg.textContent = "That email or password wasn’t recognized."; }
      }).catch(function () {
        loginMsg.className = "portal-msg err"; loginMsg.textContent = "Something went wrong. Please try again.";
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Sign In"; }
      });
    });
  }

  var signOut = $("signOut");
  if (signOut) {
    signOut.addEventListener("click", function () {
      PortalData.logout().then(function () {
        appView.hidden = true;
        loginView.hidden = false;
        loginForm.reset();
        window.scrollTo(0, 0);
      });
    });
  }

  // ---- Auth bootstrap ----
  // TODO(Clerk) Phase 1: when PORTAL_CONFIG.clerkPublishableKey is set, load the
  // Clerk SDK, require a signed-in session before revealing the dashboard, and
  // use clerk.session.getToken() as the Bearer token for every API call. Read
  // client id + account_type from Clerk's user metadata. Until then we run the
  // mock login form below (PREVIEW_MODE).
  function initAuth() {
    if (!PREVIEW_MODE) {
      // TODO(Clerk): initialize Clerk here and gate the app on a valid session.
      return;
    }
    // Preview mode: never collect credentials — the portal isn't connected to
    // anything, and a real client typing a real password into a mock form is
    // worse than no form. Hide the login form, offer explicit demo entry.
    if (loginForm) loginForm.hidden = true;
    var entry = $("previewEntry");
    if (entry) entry.hidden = false;
    var title = $("loginTitle"), sub = $("loginSub");
    if (title) title.textContent = "Client Portal Preview";
    if (sub) sub.textContent = "Explore the portal with sample data. Real client logins open here at launch.";
    function enter(type) {
      PortalData._type = type;
      showDashboard(MOCK[type].client);
    }
    var p = $("demoPersonal"), c = $("demoCommercial");
    if (p) p.addEventListener("click", function () { enter("personal"); });
    if (c) c.addEventListener("click", function () { enter("commercial"); });
    // Deep links (?demo=commercial / ?demo=personal) still jump straight in.
    var m = /[?&](?:demo|type)=(commercial|personal)/.exec(location.search);
    if (m) enter(m[1]);
  }

  initTabs();
  initHolderForm();
  initContactForm();
  initPlaceholderDownloads();
  initAuth();

  // Local-dev hook so the loading/error paths can be exercised from the
  // console (the mock data layer never fails on its own). Not defined on the
  // live domain.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.__portalDebug = { data: PortalData, reload: loadDashboard };
  }
})();
