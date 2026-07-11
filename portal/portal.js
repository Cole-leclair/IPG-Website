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
    // Clerk publishable key (public — safe to expose in client code).
    clerkPublishableKey: "pk_test_ZXhjaXRpbmctb3lzdGVyLTc1LmNsZXJrLmFjY291bnRzLmRldiQ",
    // Base path for the portal API (Netlify functions). Used in Phase 2 when
    // the PortalData getters below start calling real endpoints.
    apiBase: "/.netlify/functions"
  };

  // A pk_test_ key is a Clerk DEVELOPMENT instance — valid only on localhost.
  // So real login turns on locally for testing, while the deployed portal at
  // ipg.team stays in PREVIEW MODE (demo buttons + mock data) until a
  // production key (pk_live_) is set — which then activates login everywhere.
  var IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var IS_DEV_KEY = /^pk_test_/.test(PORTAL_CONFIG.clerkPublishableKey);
  var CLERK_ENABLED = !!PORTAL_CONFIG.clerkPublishableKey && (IS_LOCAL || !IS_DEV_KEY);
  var PREVIEW_MODE = !CLERK_ENABLED;

  // PREVIEW ONLY: which mock dataset to demo. In production the account type is
  // NOT chosen here — it comes from Bindly (via Clerk metadata). This just lets
  // us demo both experiences: add ?demo=commercial (or ?demo=personal) to the
  // URL. Returns the requested type, or null when no demo param is present.
  function demoParam() {
    var m = /[?&](?:demo|type)=(commercial|personal|admin)/.exec(location.search);
    return m ? m[1] : null;
  }

  // Staff reach the SAME login via the discreet footer "Team Login" link
  // (/portal/?staff=1). There's one login door; role decides the view. This
  // flag only swaps the login-card copy so staff aren't greeted with
  // client-facing wording — it grants no access on its own.
  var STAFF_ENTRY = /[?&]staff=1(?:&|$)/.test(location.search);
  function applyStaffCopy() {
    var title = $("loginTitle"), sub = $("loginSub");
    if (title) title.textContent = "Team Login";
    if (sub) sub.textContent = "Sign in to manage client portal accounts.";
  }

  // When someone clicks an invite email, Clerk sends them back here with a
  // one-time "ticket" in the URL. We finish the sign-up natively (set password)
  // instead of using Clerk's hosted page. See startAcceptFlow().
  var inAcceptFlow = false;
  function getClerkTicket() {
    var m = /[?&]__clerk_ticket=([^&]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
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

  // Two worlds behind one interface:
  //   * PREVIEW / demo  -> return the in-memory MOCK data, so the public preview
  //                        build is fully clickable with no backend or login.
  //   * LIVE (real client signed in via Clerk) -> call the Netlify functions,
  //                        which verify the Clerk token, resolve the caller's
  //                        Bindly client id from the VERIFIED token, and proxy
  //                        to Bindly's portal read API. The browser never sends
  //                        its own client id — it's derived server-side.
  // PREVIEW_MODE decides which: it's true only when Clerk isn't active (see the
  // CONFIG block). The UI (renderPolicies etc.) is identical either way — the
  // backend shapes each response to match exactly what the renderers expect.
  var PortalData = {
    // Which account view is active. In preview it's set by the demo button; in
    // live mode renderAuthState sets it from the signed-in user's Clerk
    // account_type (which itself mirrors the Bindly record). Used to pick the
    // MOCK dataset AND to skip the commercial-only certificates call for
    // personal clients (whose backend would 403).
    _type: "personal",

    // GET documents -> [{ name, kind, date, url }]. In live mode `url` is a
    // real 15-minute signed link straight from Bindly.
    getDocuments: function () {
      if (PREVIEW_MODE) return Promise.resolve(MOCK[this._type].documents.slice());
      return authedApi("/portal-documents").then(function (b) { return b.documents || []; });
    },
    // GET policies -> [{ type, number, carrier, term, status, renewsSoon }]
    getPolicies: function () {
      if (PREVIEW_MODE) return Promise.resolve(MOCK[this._type].policies.slice());
      return authedApi("/portal-policies").then(function (b) { return b.policies || []; });
    },
    // GET issued certificates -> [{ id, name, address, status, date, url }].
    // Commercial only — personal accounts have no certs (and the backend 403s),
    // so short-circuit to [] rather than letting that reject the dashboard load.
    getHolders: function () {
      if (this._type !== "commercial") return Promise.resolve([]);
      if (PREVIEW_MODE) return Promise.resolve((MOCK[this._type].holders || []).slice());
      return authedApi("/portal-cert-holders").then(function (b) { return b.holders || []; });
    },
    // Self-service issue. Client supplies holder name + address only, so every
    // certificate is standard ACORD 25 wording off the master COI — always
    // issues INSTANTLY. Returns { ok, holder:{ id, name, address, status, date, url } }.
    addHolder: function (data) {
      if (PREVIEW_MODE) {
        var street = [data.address1, data.address2].filter(Boolean).join(", ");
        var region = [data.city, [data.state, data.zip].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ");
        return Promise.resolve({ ok: true, status: "issued", holder: {
          id: "h-" + Date.now(),
          name: data.name,
          address: [street, region].filter(Boolean).join(", "),
          status: "issued",
          date: "Just now",
          url: "#"
        }});
      }
      return authedApi("/portal-cert-holders", { method: "POST", body: data });
    },
    // GET profile -> { name, company, email, phone, address }.
    getAccount: function () {
      if (PREVIEW_MODE) return Promise.resolve(MOCK[this._type].account);
      return authedApi("/portal-me").then(function (b) { return b.client || {}; });
    },
    // Additional contacts — reference people (billing/HR/etc.), not portal
    // logins. Live, they're NATIVE to the Bindly client record. Shape:
    // [{ id, name, role, email, phone }].
    getContacts: function () {
      if (PREVIEW_MODE) return Promise.resolve((MOCK[this._type].account.contacts || []).slice());
      return authedApi("/portal-contacts").then(function (b) { return b.contacts || []; });
    },
    addContact: function (data) {
      if (PREVIEW_MODE) {
        var c = { id: "c-" + Date.now(), name: data.name, role: data.role || "", email: data.email || "", phone: data.phone || "" };
        MOCK[this._type].account.contacts.push(c);
        return Promise.resolve({ ok: true, contact: c });
      }
      return authedApi("/portal-contacts", { method: "POST", body: data });
    },
    updateContact: function (id, data) {
      if (PREVIEW_MODE) {
        var list = MOCK[this._type].account.contacts;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) {
            list[i] = { id: id, name: data.name, role: data.role || "", email: data.email || "", phone: data.phone || "" };
            return Promise.resolve({ ok: true, contact: list[i] });
          }
        }
        return Promise.resolve({ ok: false });
      }
      return authedApi("/portal-contacts?id=" + encodeURIComponent(id), { method: "PUT", body: data });
    },
    removeContact: function (id) {
      if (PREVIEW_MODE) {
        var list = MOCK[this._type].account.contacts;
        MOCK[this._type].account.contacts = list.filter(function (c) { return c.id !== id; });
        return Promise.resolve({ ok: true });
      }
      return authedApi("/portal-contacts?id=" + encodeURIComponent(id), { method: "DELETE" });
    },
    isCommercial: function () { return this._type === "commercial"; },
    logout: function () { return Promise.resolve(); }
  };

  // Local view state (mock). Holders added in-session live here.
  var state = { policies: [], holders: [], commercial: false, contacts: [] };

  // =====================================================================
  // ADMIN DATA LAYER — the staff/admin tab (create + manage client logins).
  // Two worlds, same interface:
  //   * PREVIEW / demo  -> operates on the in-memory MOCK_ADMIN_USERS below,
  //                        so the tab is fully clickable with no backend.
  //   * REAL (staff signed in) -> calls the portal-admin-users function, which
  //                        talks to Clerk (invite emails, invited/active status).
  // adminPreview decides which. Set true by the "View demo — IPG Admin" button;
  // false for a real signed-in staff user.
  // =====================================================================
  var adminPreview = false;
  var adminSelfId = null; // the signed-in staff member's own id (so they can't self-delete)
  var adminIsAdmin = false; // true when the signed-in user is role 'admin' (not just staff)
  var adminState = { users: [], team: [] };

  // Sample data for the demo only — mirrors what Clerk returns in production.
  var MOCK_ADMIN_USERS = [
    { id: "u-1", email: "maria@acmeroofing.com", name: "Maria Delgado", bindly_client_id: "BND-10234", account_type: "commercial", role: "client", status: "active", created: "2026-07-02" },
    { id: "u-2", email: "jordan.rivera@example.com", name: "Jordan Rivera", bindly_client_id: "BND-10891", account_type: "personal", role: "client", status: "active", created: "2026-06-28" },
    { id: "i-1", email: "dana@brightpathhr.com", name: "Dana Cole", bindly_client_id: "BND-11002", account_type: "commercial", role: "client", status: "invited", created: "2026-07-10" }
  ];
  var MOCK_ADMIN_TEAM = [
    { id: "t-self", email: "cole@ipg.team", name: "Cole LeClair", role: "admin", status: "active", created: "2026-07-01" },
    { id: "t-2", email: "meagan@ipg.team", name: "Meagan Reyes", role: "staff", status: "active", created: "2026-07-05" },
    { id: "t-3", email: "newhire@ipg.team", name: "Jamie Park", role: "staff", status: "invited", created: "2026-07-11" }
  ];

  // Attach the signed-in user's Clerk token to every backend call so the server
  // can verify WHO is asking (and re-derive their client id / role) — never
  // trust the browser's claim of its own identity. Shared by both the client
  // data layer (PortalData) and the staff/admin data layer (AdminData).
  function getToken() {
    if (window.Clerk && window.Clerk.session && window.Clerk.session.getToken) {
      return window.Clerk.session.getToken();
    }
    return Promise.resolve(null);
  }
  function authedApi(path, opts) {
    return getToken().then(function (tok) {
      opts = opts || {};
      var headers = { "Content-Type": "application/json" };
      if (tok) headers["Authorization"] = "Bearer " + tok;
      return fetch(PORTAL_CONFIG.apiBase + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) throw new Error(body.error || ("Request failed (" + r.status + ")"));
          return body;
        });
      });
    });
  }

  var AdminData = {
    load: function () {
      if (adminPreview) return Promise.resolve({ users: MOCK_ADMIN_USERS.slice(), team: MOCK_ADMIN_TEAM.slice() });
      return authedApi("/portal-admin-users").then(function (b) { return { users: b.users || [], team: b.team || [] }; });
    },
    invite: function (data) {
      if (adminPreview) {
        var u = { id: "i-" + Date.now(), email: data.email, name: data.name || "",
                  bindly_client_id: data.bindlyClientId, account_type: data.accountType,
                  role: "client", status: "invited", created: new Date().toISOString() };
        MOCK_ADMIN_USERS.unshift(u);
        return Promise.resolve({ ok: true, user: u });
      }
      return authedApi("/portal-admin-users", { method: "POST", body: data });
    },
    // Invite a colleague as staff/admin (admin-only, enforced server-side).
    inviteTeam: function (data) {
      if (adminPreview) {
        var m = { id: "t-" + Date.now(), email: data.email, name: data.name || "",
                  role: data.role, status: "invited", created: new Date().toISOString() };
        MOCK_ADMIN_TEAM.unshift(m);
        return Promise.resolve({ ok: true, user: m });
      }
      return authedApi("/portal-admin-users", { method: "POST", body: { email: data.email, name: data.name, role: data.role } });
    },
    resend: function (row) {
      if (adminPreview) return Promise.resolve({ ok: true });
      return authedApi("/portal-admin-users", { method: "POST", body: {
        action: "resend", id: row.id, email: row.email, role: row.role || "client",
        bindlyClientId: row.bindly_client_id, accountType: row.account_type, name: row.name
      }});
    },
    revoke: function (row) {
      if (adminPreview) {
        MOCK_ADMIN_USERS = MOCK_ADMIN_USERS.filter(function (x) { return x.id !== row.id; });
        return Promise.resolve({ ok: true });
      }
      return authedApi("/portal-admin-users", { method: "POST", body: { action: "revoke", id: row.id } });
    },
    // Permanently remove an ACTIVE login (deletes the Clerk user).
    remove: function (row) {
      if (adminPreview) {
        MOCK_ADMIN_USERS = MOCK_ADMIN_USERS.filter(function (x) { return x.id !== row.id; });
        return Promise.resolve({ ok: true });
      }
      return authedApi("/portal-admin-users", { method: "POST", body: { action: "delete", id: row.id } });
    }
  };

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
  var acceptView = $("portalAccept");
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
    // Only two statuses exist today: policies are "active", issued certs are
    // "issued". (The old "received"/"in review" states went away with the
    // review-routed cert flow — every holder now issues instantly.)
    var map = { active: ["active", "Active"], issued: ["issued", "Issued"] };
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
      if (a.hasAttribute("data-edit") || a.hasAttribute("data-remove") || a.hasAttribute("data-retry") ||
          a.hasAttribute("data-resend") || a.hasAttribute("data-revoke") || a.hasAttribute("data-remove-user") || a.hasAttribute("data-users-retry")) return;
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
      var data = {
        name: $("hName").value,
        address1: $("hAddr1").value,
        address2: $("hAddr2").value,
        city: $("hCity").value,
        state: $("hState").value,
        zip: $("hZip").value
      };
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

  // ---- Admin tab (staff/admin only) ----
  function fmtDate(v) {
    if (!v) return "";
    // Parse a plain "YYYY-MM-DD" as LOCAL midnight (not UTC, which can show the
    // day before). Clerk timestamps arrive as unix ms and are handled as-is.
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = v + "T00:00:00";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function statusPill(status) {
    var map = { invited: ["pending", "Invited"], active: ["active", "Active"], disabled: ["pending", "Disabled"] };
    var m = map[status] || ["pending", status || ""];
    return '<span class="badge ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  function findRow(id) {
    return adminState.users.filter(function (x) { return x.id === id; })[0]
        || adminState.team.filter(function (x) { return x.id === id; })[0];
  }

  // One list-row for either a client login or a team member.
  function rowHtml(u, isTeam) {
    var bits = isTeam
      ? [ u.name ? u.email : "", cap(u.role), fmtDate(u.created) ].filter(Boolean)
      : [ u.name ? u.email : "", cap(u.account_type), u.bindly_client_id ? "Bindly " + u.bindly_client_id : "", fmtDate(u.created) ].filter(Boolean);
    var actions;
    if (u.status === "invited") {
      actions = '<span class="contact-actions">' +
        '<a href="#" class="doc-dl" data-resend="' + esc(u.id) + '">Resend</a>' +
        '<a href="#" class="doc-dl doc-dl-danger" data-revoke="' + esc(u.id) + '">Revoke</a>' +
      '</span>';
    } else if (u.id === adminSelfId) {
      actions = '<span class="you-tag">You</span>'; // can't remove your own login
    } else {
      actions = '<span class="contact-actions">' +
        '<a href="#" class="doc-dl doc-dl-danger" data-remove-user="' + esc(u.id) + '">Remove</a>' +
      '</span>';
    }
    return '<li><span class="doc-ico">' + PERSON_ICON + '</span>' +
      '<span class="doc-meta"><span class="n">' + esc(u.name || u.email) + '</span>' +
      '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
      statusPill(u.status) + actions + '</li>';
  }

  function renderUsers() {
    var el = $("userList");
    if (!el) return;
    el.innerHTML = adminState.users.length
      ? adminState.users.map(function (u) { return rowHtml(u, false); }).join("")
      : '<li class="doc-empty">No client logins yet.</li>';
  }

  function renderTeam() {
    var el = $("teamList");
    if (!el) return;
    el.innerHTML = adminState.team.length
      ? adminState.team.map(function (u) { return rowHtml(u, true); }).join("")
      : '<li class="doc-empty">No team members yet.</li>';
  }

  function loadUsers() {
    var uel = $("userList");
    if (uel) uel.innerHTML = '<li class="doc-empty">Loading…</li>';
    var tel = $("teamList");
    if (tel && adminIsAdmin) tel.innerHTML = '<li class="doc-empty">Loading…</li>';
    AdminData.load().then(function (res) {
      adminState.users = res.users || [];
      adminState.team = res.team || [];
      renderUsers();
      renderTeam();
    }).catch(function (err) {
      var extra = err && err.message ? ' (' + esc(err.message) + ')' : '';
      if (uel) uel.innerHTML = '<li class="doc-empty">Couldn’t load client logins — ' +
        '<a href="#" class="doc-dl" data-users-retry>try again</a>.' + extra + '</li>';
      if (tel && adminIsAdmin) tel.innerHTML = '<li class="doc-empty">Couldn’t load team members.</li>';
    });
  }

  function initInviteForm() {
    var form = $("inviteForm");
    if (!form) return;
    var confirmBox = $("inviteConfirm");
    var pending = null;

    function renderConfirm(p) {
      var rows = [["Email", p.email]];
      if (p.name) rows.push(["Name", p.name]);
      rows.push(["Account type", cap(p.accountType)], ["Bindly client", p.bindlyClientId]);
      $("inviteConfirmBody").innerHTML = rows.map(function (r) {
        return '<div class="acct-item"><div class="k">' + esc(r[0]) + '</div><div class="v">' + esc(r[1] || "—") + '</div></div>';
      }).join("");
      $("inviteConfirmMsg").textContent = "";
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("inviteMsg"); msg.className = "portal-msg"; msg.textContent = "";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      pending = {
        email: $("ivEmail").value.trim(),
        name: $("ivName").value.trim(),
        bindlyClientId: $("ivClient").value.trim(),
        accountType: $("ivType").value === "commercial" ? "commercial" : "personal"
      };
      // TODO(Bindly): when "look up client by email" is available (ARCHITECTURE
      // §9 q2), call it here and show the MATCHED Bindly client (name/address)
      // for confirmation instead of just echoing the typed id. This confirm
      // step is the seam where that check lands.
      renderConfirm(pending);
      form.hidden = true;
      confirmBox.hidden = false;
    });

    $("inviteBackBtn").addEventListener("click", function () {
      confirmBox.hidden = true; form.hidden = false;
    });

    $("inviteSendBtn").addEventListener("click", function () {
      if (!pending) return;
      var cmsg = $("inviteConfirmMsg"); cmsg.className = "portal-msg"; cmsg.textContent = "Sending…";
      var btn = $("inviteSendBtn"); btn.disabled = true;
      AdminData.invite(pending).then(function (res) {
        if (res && res.ok) {
          confirmBox.hidden = true; form.hidden = false; form.reset();
          var msg = $("inviteMsg"); msg.className = "portal-msg ok";
          msg.textContent = "Invite sent to " + pending.email + ". They’ll get an email to set their password.";
          pending = null;
          loadUsers();
        } else {
          cmsg.className = "portal-msg err"; cmsg.textContent = "Couldn’t send the invite. Please try again.";
        }
      }).catch(function (err) {
        cmsg.className = "portal-msg err";
        cmsg.textContent = err && err.message ? err.message : "Couldn’t send the invite.";
      }).finally(function () { btn.disabled = false; });
    });
  }

  function dropRow(id) {
    adminState.users = adminState.users.filter(function (x) { return x.id !== id; });
    adminState.team = adminState.team.filter(function (x) { return x.id !== id; });
    renderUsers();
    renderTeam();
  }

  function onListClick(e) {
    var a = e.target && e.target.closest ? e.target.closest("[data-resend],[data-revoke],[data-remove-user],[data-users-retry]") : null;
    if (!a) return;
    e.preventDefault();
    if (a.hasAttribute("data-users-retry")) { loadUsers(); return; }
    var resendId = a.getAttribute("data-resend");
    var revokeId = a.getAttribute("data-revoke");
    var removeId = a.getAttribute("data-remove-user");
    if (resendId) {
      var row = findRow(resendId);
      if (row) AdminData.resend(row).then(function () { showToast("Invite re-sent to " + row.email + "."); });
    } else if (revokeId) {
      var r2 = findRow(revokeId);
      if (!r2) return;
      if (!window.confirm("Revoke the invite for " + r2.email + "?")) return;
      AdminData.revoke(r2).then(function () { dropRow(revokeId); })
        .catch(function (err) { showToast(err && err.message ? err.message : "Couldn’t revoke that invite."); });
    } else if (removeId) {
      var r3 = findRow(removeId);
      if (!r3) return;
      var isTeam = r3.role === "staff" || r3.role === "admin";
      var msg = isTeam
        ? "Remove " + r3.email + " from the team?\n\nThis permanently deletes their login and admin access."
        : "Remove " + r3.email + "?\n\nThis permanently deletes their login — they’ll no longer be able to sign in.";
      if (!window.confirm(msg)) return;
      AdminData.remove(r3).then(function () { dropRow(removeId); })
        .catch(function (err) { showToast(err && err.message ? err.message : "Couldn’t remove that login."); });
    }
  }

  function initUserActions() {
    var userList = $("userList");
    if (userList) userList.addEventListener("click", onListClick);
    var teamList = $("teamList");
    if (teamList) teamList.addEventListener("click", onListClick);
    var refresh = $("usersRefresh");
    if (refresh) refresh.addEventListener("click", loadUsers);
    var teamRefresh = $("teamRefresh");
    if (teamRefresh) teamRefresh.addEventListener("click", loadUsers);
  }

  function initTeamInviteForm() {
    var form = $("teamInviteForm");
    var modal = $("teamModal");
    if (!form || !modal) return;

    function openModal() {
      form.reset();
      var msg = $("teamMsg"); if (msg) { msg.className = "portal-msg"; msg.textContent = ""; }
      modal.hidden = false;
      var email = $("tmEmail"); if (email) email.focus();
    }
    function closeModal() { modal.hidden = true; }

    var addBtn = $("teamAddBtn");
    if (addBtn) addBtn.addEventListener("click", openModal);
    // Close on the X, Cancel, or the dark backdrop.
    modal.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("[data-close-team]")) closeModal();
    });
    // Close on Escape.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("teamMsg"); msg.className = "portal-msg"; msg.textContent = "";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var data = {
        email: $("tmEmail").value.trim(),
        name: $("tmName").value.trim(),
        role: $("tmRole").value === "admin" ? "admin" : "staff"
      };
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      AdminData.inviteTeam(data).then(function (res) {
        if (res && res.ok) {
          closeModal();
          showToast("Invite sent to " + data.email + " (" + cap(data.role) + "). They’ll get an email to set their password.");
          loadUsers();
        } else {
          msg.className = "portal-msg err"; msg.textContent = "Couldn’t send the invite. Please try again.";
        }
      }).catch(function (err) {
        msg.className = "portal-msg err"; msg.textContent = err && err.message ? err.message : "Couldn’t send the invite.";
      }).finally(function () { if (btn) btn.disabled = false; });
    });
  }

  // Show client tabs vs the admin-only tab. Staff see only Admin; clients never
  // see Admin. (The Certificates tab stays commercial-gated in showDashboard.)
  function setChrome(mode) {
    var clientTabs = ["overview", "documents", "certificates", "account"];
    var staffTabs = ["admin", "team"];
    document.querySelectorAll(".ptab").forEach(function (t) {
      var name = t.getAttribute("data-tab");
      if (staffTabs.indexOf(name) !== -1) t.hidden = mode !== "admin";
      else if (clientTabs.indexOf(name) !== -1) t.hidden = mode === "admin";
    });
  }

  function showAdmin(user) {
    loginView.hidden = true;
    appView.hidden = false;
    // Team management is admin-only (staff can only manage clients).
    adminIsAdmin = adminPreview || !!(user && user.role === "admin");
    adminSelfId = (user && user.id) || (adminPreview ? "t-self" : null);
    setChrome("admin");
    // The Team tab exists only for admins; staff never see it.
    var teamTab = $("teamTab"); if (teamTab) teamTab.hidden = !adminIsAdmin;
    $("pUser").textContent = (user && user.name) || "IPG Admin";
    $("pWelcome").textContent = "Admin";
    $("pCompany").textContent = adminIsAdmin
      ? "Create and manage client logins and team members."
      : "Create and manage client logins.";
    activateTab("admin");
    loadUsers();
    window.scrollTo(0, 0);
  }

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

    // Client chrome: show client tabs, hide the admin-only tab.
    setChrome("client");
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

      // Clerk owns real sign-in: it verifies credentials and its listener
      // reveals the dashboard on success (a one-time code step appears if
      // required). This form is only ever visible when Clerk is active, so if
      // Clerk somehow isn't loaded we surface an outage rather than pretending
      // to sign the client in.
      if (!(CLERK_ENABLED && window.Clerk)) {
        loginMsg.className = "portal-msg err";
        loginMsg.textContent = "Sign-in is temporarily unavailable. Please try again shortly.";
        if (btn) { btn.disabled = false; btn.textContent = "Sign In"; }
        return;
      }

      clerkSignIn($("plEmail").value.trim(), $("plPass").value)
        .then(function (r) {
          if (r && r.need2fa) { show2fa(r.strategy); }
          // r.done -> the Clerk listener reveals the dashboard.
        })
        .catch(function (err) {
          loginMsg.className = "portal-msg err";
          loginMsg.textContent = clerkErrMsg(err);
        })
        .finally(function () { if (btn) { btn.disabled = false; btn.textContent = "Sign In"; } });
    });
  }

  var twoFactorForm = $("twoFactorForm");
  if (twoFactorForm) {
    twoFactorForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var tfMsg = $("tfMsg");
      tfMsg.className = "portal-msg"; tfMsg.textContent = "";
      if (!twoFactorForm.checkValidity()) { twoFactorForm.reportValidity(); return; }
      var btn = twoFactorForm.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Verifying…"; }
      clerkVerifyCode($("tfCode").value.trim())
        .catch(function () {
          tfMsg.className = "portal-msg err";
          tfMsg.textContent = "That code wasn’t right. Please try again.";
        })
        .finally(function () { if (btn) { btn.disabled = false; btn.textContent = "Verify & sign in"; } });
    });
  }

  var acceptForm = $("acceptForm");
  if (acceptForm) {
    acceptForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("acceptMsg"); msg.className = "portal-msg"; msg.textContent = "";
      if (!acceptForm.checkValidity()) { acceptForm.reportValidity(); return; }
      var p1 = $("acPass").value, p2 = $("acPass2").value;
      if (p1 !== p2) { acceptError("The two passwords don’t match."); return; }
      if (!(window.Clerk && window.Clerk.client && window.Clerk.client.signUp)) {
        acceptError("Setup is temporarily unavailable. Please try again shortly.");
        return;
      }
      var btn = acceptForm.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Setting up…"; }
      window.Clerk.client.signUp.update({ password: p1 })
        .then(function (su) {
          if (su.status === "complete") {
            return window.Clerk.setActive({ session: su.createdSessionId }).then(finishAccept);
          }
          throw new Error("incomplete");
        })
        .catch(function (err) {
          var e0 = err && err.errors && err.errors[0];
          acceptError((e0 && (e0.longMessage || e0.long_message || e0.message)) ||
            "That password wasn’t accepted. Try a longer, less common password (8+ characters).");
        })
        .finally(function () { if (btn) { btn.disabled = false; btn.textContent = "Set password & sign in"; } });
    });
  }

  var signOut = $("signOut");
  if (signOut) {
    signOut.addEventListener("click", function () {
      // Real auth: Clerk ends the session; its listener re-renders the login.
      if (CLERK_ENABLED && window.Clerk) {
        window.Clerk.signOut();
        return;
      }
      PortalData.logout().then(function () {
        appView.hidden = true;
        loginView.hidden = false;
        if (loginForm) loginForm.reset();
        window.scrollTo(0, 0);
      });
    });
  }

  // ---- Auth bootstrap ----
  function initAuth() {
    var ticket = getClerkTicket();
    if (CLERK_ENABLED) { initClerk(ticket); if (STAFF_ENTRY && !ticket) applyStaffCopy(); return; }
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
      adminPreview = false;
      PortalData._type = type;
      showDashboard(MOCK[type].client);
    }
    var p = $("demoPersonal"), c = $("demoCommercial"), ad = $("demoAdmin");
    if (p) p.addEventListener("click", function () { enter("personal"); });
    if (c) c.addEventListener("click", function () { enter("commercial"); });
    // Demo the admin experience against in-memory sample data.
    if (ad) ad.addEventListener("click", function () { adminPreview = true; showAdmin({ name: "IPG Admin" }); });
    // Deep links (?demo=commercial / ?demo=personal / ?demo=admin) jump straight in.
    var demo = demoParam();
    if (demo === "admin") { adminPreview = true; showAdmin({ name: "IPG Admin" }); }
    else if (demo) enter(demo);
    if (STAFF_ENTRY) applyStaffCopy();
  }

  // ---- Real auth via Clerk (native IPG form) ----
  // Clerk (loaded async in index.html) owns identity, passwords, MFA, and
  // sessions — but we drive it through the site's OWN login form below via
  // Clerk's headless API, so sign-in looks native instead of Clerk's floating
  // card. On success we hold a Clerk session; every future API call (Phase 2)
  // sends its JWT as a Bearer token, and the server re-derives the client id +
  // account type from that VERIFIED token, never trusting the browser.
  function whenClerkReady(cb) {
    if (window.Clerk) return cb();
    var tries = 0;
    var t = setInterval(function () {
      if (window.Clerk) { clearInterval(t); cb(); }
      else if (++tries > 120) { clearInterval(t); } // ~6s, then give up
    }, 50);
  }

  function initClerk(ticket) {
    // Keep the native IPG login form; just make sure the preview demo buttons
    // never show.
    var entry = $("previewEntry"); if (entry) entry.hidden = true;
    whenClerkReady(function () {
      window.Clerk.load().then(function () {
        // While finishing an invite (setting a password), don't let Clerk's
        // change listener flash the login screen underneath.
        window.Clerk.addListener(function () { if (!inAcceptFlow) renderAuthState(); });
        if (ticket) { startAcceptFlow(ticket); return; }
        renderAuthState();
      }).catch(function () {
        var sub = $("loginSub");
        if (sub) sub.textContent = "Sign-in is temporarily unavailable. Please try again shortly.";
      });
    });
  }

  // ---- Accept an invite natively (set your password on ipg.team) ----
  function showAcceptView() {
    if (loginView) loginView.hidden = true;
    if (appView) appView.hidden = true;
    if (acceptView) acceptView.hidden = false;
    window.scrollTo(0, 0);
  }
  function acceptError(msg) {
    var el = $("acceptMsg");
    if (el) { el.className = "portal-msg err"; el.textContent = msg; }
  }
  function finishAccept() {
    inAcceptFlow = false;
    // Strip the one-time ticket from the URL, then reveal their dashboard.
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, location.pathname);
    }
    if (acceptView) acceptView.hidden = true;
    renderAuthState();
  }
  function startAcceptFlow(ticket) {
    inAcceptFlow = true;
    showAcceptView();
    // Exchange the ticket for a sign-up (email is pre-filled + verified).
    window.Clerk.client.signUp.create({ strategy: "ticket", ticket: ticket })
      .then(function (su) {
        var emailField = $("acEmail");
        if (emailField) emailField.value = su.emailAddress || "";
        // If somehow already complete (no password needed), just sign them in.
        if (su.status === "complete") {
          return window.Clerk.setActive({ session: su.createdSessionId }).then(finishAccept);
        }
      })
      .catch(function () {
        acceptError("This invitation link is invalid or has expired. Please ask IPG to re-send your invite.");
        var form = $("acceptForm"); if (form) form.hidden = true;
      });
  }

  function renderAuthState() {
    var Clerk = window.Clerk;
    if (Clerk && Clerk.user) {
      // Signed in — build the client context. The browser reads publicMetadata
      // only to choose which view to show; authorization is still enforced
      // server-side off the verified Clerk JWT.
      adminPreview = false; // a real staff user hits the live backend, not the mock
      var md = Clerk.user.publicMetadata || {};
      var email = Clerk.user.primaryEmailAddress && Clerk.user.primaryEmailAddress.emailAddress;
      var name = Clerk.user.fullName || Clerk.user.firstName || email || "Client";
      // Staff/admin go to the admin tab (they have no client dashboard).
      var role = (md.role === "staff" || md.role === "admin") ? md.role : "client";
      if (role !== "client") { showAdmin({ name: name, role: role, id: Clerk.user.id }); return; }
      var type = md.account_type === "commercial" ? "commercial" : "personal";
      PortalData._type = type;
      showDashboard({ name: name, company: md.company || "", type: type });
    } else {
      // Signed out — show the native login form (reset any code step).
      appView.hidden = true;
      loginView.hidden = false;
      if (loginForm) loginForm.hidden = false;
      if (twoFactorForm) twoFactorForm.hidden = true;
      window.scrollTo(0, 0);
    }
  }

  // Sign in through Clerk using the site's own form fields. Steps: start the
  // sign-in with the email, submit the password, then — if Clerk asks for a
  // one-time code (email verification / 2FA) — hand off to the code form.
  // Resolves to { done:true } once signed in, or { need2fa, strategy } when a
  // code is required.
  var _tfStrategy = null;

  function clerkSignIn(email, password) {
    var Clerk = window.Clerk;
    return Clerk.client.signIn.create({ identifier: email })
      .then(function (si) {
        var hasPassword = (si.supportedFirstFactors || []).some(function (f) {
          return f.strategy === "password";
        });
        if (!hasPassword) {
          var e0 = new Error("no_password_factor");
          e0.clerkStatus = "no_password_factor";
          throw e0;
        }
        return si.attemptFirstFactor({ strategy: "password", password: password });
      })
      .then(function (res) {
        if (res.status === "complete") {
          return Clerk.setActive({ session: res.createdSessionId }).then(function () {
            return { done: true };
          });
        }
        if (res.status === "needs_second_factor") {
          var strategies = (res.supportedSecondFactors || []).map(function (f) { return f.strategy; });
          // Email one-time code: send it, then collect it in the code form.
          if (strategies.indexOf("email_code") !== -1) {
            _tfStrategy = "email_code";
            return res.prepareSecondFactor({ strategy: "email_code" }).then(function () {
              return { need2fa: true, strategy: "email_code" };
            });
          }
          // Authenticator app code: already generated on the user's device.
          if (strategies.indexOf("totp") !== -1) {
            _tfStrategy = "totp";
            return { need2fa: true, strategy: "totp" };
          }
          var e = new Error("additional_step");
          e.clerkStatus = res.status;
          e.secondFactors = strategies;
          throw e;
        }
        var e2 = new Error("additional_step");
        e2.clerkStatus = res.status;
        throw e2;
      });
  }

  // Finish sign-in after the user enters the emailed / authenticator code.
  function clerkVerifyCode(code) {
    var Clerk = window.Clerk;
    return Clerk.client.signIn.attemptSecondFactor({ strategy: _tfStrategy, code: code })
      .then(function (res) {
        if (res.status === "complete") {
          return Clerk.setActive({ session: res.createdSessionId });
        }
        throw new Error("incomplete");
      });
  }

  function show2fa(strategy) {
    if (loginForm) loginForm.hidden = true;
    if (twoFactorForm) twoFactorForm.hidden = false;
    var sub = $("loginSub");
    if (sub) {
      sub.textContent = strategy === "email_code"
        ? "We emailed you a 6-digit code. Enter it below to finish signing in."
        : "Enter the code from your authenticator app to finish signing in.";
    }
    var code = $("tfCode"); if (code) { code.value = ""; code.focus(); }
  }

  function clerkErrMsg(err) {
    // A sign-in step we don't have UI for yet (e.g. an unexpected 2FA type).
    if (err && err.clerkStatus) {
      return "This account needs an extra sign-in step. Please contact IPG.";
    }
    // Generic message for auth failures — never reveal whether the email exists.
    return "That email or password wasn’t recognized.";
  }

  initTabs();
  initHolderForm();
  initContactForm();
  initInviteForm();
  initTeamInviteForm();
  initUserActions();
  initPlaceholderDownloads();
  initAuth();

  // Local-dev hook so the loading/error paths can be exercised from the
  // console (the mock data layer never fails on its own). Not defined on the
  // live domain.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.__portalDebug = { data: PortalData, reload: loadDashboard,
      admin: AdminData, showAdmin: function () { adminPreview = true; showAdmin({ name: "IPG Admin" }); },
      showAccept: function () { showAcceptView(); var f = $("acEmail"); if (f) f.value = "teammate@ipg.team"; } };
  }
})();
