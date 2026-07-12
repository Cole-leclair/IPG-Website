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
  // CONFIG — Clerk auth wiring for the portal.
  // =====================================================================
  var PORTAL_CONFIG = {
    // Clerk publishable key (public — safe to expose in client code). The key
    // is chosen ONCE in index.html (window.PORTAL_CLERK): the Development
    // instance on localhost, production (clerk.ipg.team) everywhere else —
    // so this file and the script tag can never point at different instances.
    clerkPublishableKey: (window.PORTAL_CLERK && window.PORTAL_CLERK.key) || "",
    // Base path for the portal API (Netlify functions). Used in Phase 2 when
    // the PortalData getters below start calling real endpoints.
    apiBase: "/.netlify/functions"
  };

  // A pk_test_ key is a Clerk DEVELOPMENT instance — valid only on localhost.
  // So real login runs locally against the dev instance for testing, and on
  // ipg.team against the production (pk_live_) instance. If no key is set at
  // all, CLERK_ENABLED is false and the login form's submit handler reports
  // that sign-in is unavailable rather than collecting a password with no
  // backend behind it.
  var IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var IS_DEV_KEY = /^pk_test_/.test(PORTAL_CONFIG.clerkPublishableKey);
  var CLERK_ENABLED = !!PORTAL_CONFIG.clerkPublishableKey && (IS_LOCAL || !IS_DEV_KEY);

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
  // DATA LAYER — the only place that talks to the backend. Each method calls
  // a Netlify function that verifies the signed-in Clerk token, resolves the
  // caller's Bindly client id from the VERIFIED token (never from anything the
  // browser sends), and proxies to Bindly's portal read API. The UI below
  // (renderPolicies etc.) never changes — the backend shapes each response to
  // match exactly what the renderers expect.
  //
  // Personal clients see homeowners/auto/umbrella-style policies, their
  // documents, and their account. Commercial clients additionally get the
  // Certificates tab + COI request flow, and a company on their profile.
  // =====================================================================
  var PortalData = {
    // Which account view is active. renderAuthState sets it from the signed-in
    // user's Clerk account_type (which mirrors the Bindly record). Used to skip
    // the commercial-only certificates call for personal clients (whose backend
    // would 403).
    _type: "personal",

    // GET documents -> [{ name, kind, date, url }]. `url` is a real 15-minute
    // signed link straight from Bindly.
    getDocuments: function () {
      return authedApi("/portal-documents").then(function (b) { return b.documents || []; });
    },
    // GET policies -> [{ type, number, carrier, term, status, renewsSoon }]
    getPolicies: function () {
      return authedApi("/portal-policies").then(function (b) { return b.policies || []; });
    },
    // GET issued certificates -> [{ id, name, address, status, date, url }].
    // Commercial only — personal accounts have no certs (and the backend 403s),
    // so short-circuit to [] rather than letting that reject the dashboard load.
    getHolders: function () {
      if (this._type !== "commercial") return Promise.resolve([]);
      return authedApi("/portal-cert-holders").then(function (b) { return b.holders || []; });
    },
    // Self-service issue. Client supplies holder name + address only, so every
    // certificate is standard ACORD 25 wording off the master COI — always
    // issues INSTANTLY. Returns { ok, holder:{ id, name, address, status, date, url } }.
    addHolder: function (data) {
      return authedApi("/portal-cert-holders", { method: "POST", body: data });
    },
    // GET profile -> { name, company, email, phone, address }.
    getAccount: function () {
      return authedApi("/portal-me").then(function (b) { return b.client || {}; });
    },
    // Additional contacts — reference people (billing/HR/etc.), not portal
    // logins. They're NATIVE to the Bindly client record. Shape:
    // [{ id, name, role, email, phone }].
    getContacts: function () {
      return authedApi("/portal-contacts").then(function (b) { return b.contacts || []; });
    },
    addContact: function (data) {
      return authedApi("/portal-contacts", { method: "POST", body: data });
    },
    updateContact: function (id, data) {
      return authedApi("/portal-contacts?id=" + encodeURIComponent(id), { method: "PUT", body: data });
    },
    removeContact: function (id) {
      return authedApi("/portal-contacts?id=" + encodeURIComponent(id), { method: "DELETE" });
    },
    isCommercial: function () { return this._type === "commercial"; },
    logout: function () { return Promise.resolve(); }
  };

  // Local view state. Holders added in-session live here.
  var state = { policies: [], holders: [], commercial: false, contacts: [] };

  // =====================================================================
  // ADMIN DATA LAYER — the staff/admin tab (create + manage client logins).
  // Each method calls the portal-admin-users function, which talks to Clerk
  // (invite emails, invited/active status) and Bindly (client lookup by email).
  // =====================================================================
  var adminSelfId = null; // the signed-in staff member's own id (so they can't self-delete)
  var adminIsAdmin = false; // true when the signed-in user is role 'admin' (not just staff)
  var adminState = { users: [], team: [] };

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
      return authedApi("/portal-admin-users").then(function (b) { return { users: b.users || [], team: b.team || [] }; });
    },
    // Find the Bindly client(s) matching an email — the seam the invite form
    // uses instead of asking staff to type a Bindly client id by hand.
    lookupClient: function (email) {
      return authedApi("/portal-admin-users", { method: "POST", body: { action: "lookup", email: email } });
    },
    invite: function (data) {
      return authedApi("/portal-admin-users", { method: "POST", body: data });
    },
    // Invite a colleague as staff/admin (admin-only, enforced server-side).
    inviteTeam: function (data) {
      return authedApi("/portal-admin-users", { method: "POST", body: { email: data.email, name: data.name, role: data.role } });
    },
    resend: function (row) {
      return authedApi("/portal-admin-users", { method: "POST", body: {
        action: "resend", id: row.id, email: row.email, role: row.role || "client",
        bindlyClientId: row.bindly_client_id, accountType: row.account_type, name: row.name
      }});
    },
    revoke: function (row) {
      return authedApi("/portal-admin-users", { method: "POST", body: { action: "revoke", id: row.id } });
    },
    // Permanently remove an ACTIVE login (deletes the Clerk user).
    remove: function (row) {
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

  var bootView = $("portalBoot");
  var loginView = $("portalLogin");
  var appView = $("portalApp");
  var acceptView = $("portalAccept");
  var loginForm = $("loginForm");
  var loginMsg = $("loginMsg");

  // Hide the boot spinner once we know whether a session exists — called from
  // every path that reveals login/dashboard/accept, so it never gets stuck.
  function hideBoot() { if (bootView) bootView.hidden = true; }

  // The public ipg.team site header (logo + nav + Get a Quote) shows on the
  // login and set-password screens so the portal reads as part of the main
  // website; it's hidden inside the signed-in dashboard, which has its own
  // header. Call with `true` on any public view, `false` when the app is shown.
  function siteHeader(show) {
    var h = $("portalSiteHeader");
    if (h) h.hidden = !show;
  }

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
      // Contact Edit/Remove, error-retry, admin actions, and the invite
      // match-picker share the .doc-dl style — leave them to their own handlers.
      if (a.hasAttribute("data-edit") || a.hasAttribute("data-remove") || a.hasAttribute("data-retry") ||
          a.hasAttribute("data-resend") || a.hasAttribute("data-revoke") || a.hasAttribute("data-remove-user") ||
          a.hasAttribute("data-users-retry") || a.hasAttribute("data-pick-match")) return;
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
      : [ u.name ? u.email : "", cap(u.account_type), fmtDate(u.created) ].filter(Boolean);
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
    var matchesBox = $("inviteMatches");
    var confirmBox = $("inviteConfirm");
    var nameOverride = ""; // what staff typed in the optional Name field, if anything
    var pending = null;    // { email, name, bindlyClientId, accountType } once a match is chosen

    function resetToForm() {
      matchesBox.hidden = true; confirmBox.hidden = true; form.hidden = false;
    }

    function renderConfirm(p) {
      var rows = [["Email", p.email]];
      if (p.name) rows.push(["Name", p.name]);
      var html = rows.map(function (r) {
        return '<div class="acct-item"><div class="k">' + esc(r[0]) + '</div><div class="v">' + esc(r[1] || "—") + '</div></div>';
      }).join("");
      // Account type is auto-detected from Bindly, but Bindly's data has been
      // wrong or missing for real clients (Bobby Jones, Haven Swarts) — so
      // this is an editable dropdown, not a static label, and staff's choice
      // here always wins over whatever Bindly says.
      html += '<div class="acct-item"><div class="k">Account type</div><div class="v">' +
        '<select id="ivConfirmType">' +
        '<option value="personal"' + (p.accountType === "commercial" ? "" : " selected") + '>Personal</option>' +
        '<option value="commercial"' + (p.accountType === "commercial" ? " selected" : "") + '>Commercial</option>' +
        '</select></div></div>';
      html += '<div class="acct-item"><div class="k">Bindly client</div><div class="v">' + esc(p.bindlyClientId || "—") + '</div></div>';
      $("inviteConfirmBody").innerHTML = html;
      var cmsg = $("inviteConfirmMsg");
      cmsg.className = "portal-msg";
      cmsg.textContent = "Auto-detected from Bindly — change the account type above if it looks wrong.";
    }

    function chooseMatch(email, match) {
      pending = {
        email: email,
        name: nameOverride || match.name || "",
        bindlyClientId: match.client_id,
        accountType: match.type === "commercial" ? "commercial" : "personal"
      };
      renderConfirm(pending);
      matchesBox.hidden = true; form.hidden = true; confirmBox.hidden = false;
    }

    function renderMatches(email, clients) {
      $("inviteMatchesList").innerHTML = clients.map(function (c, i) {
        var bits = [cap(c.type === "commercial" ? "commercial" : "personal"), "Bindly " + c.client_id].filter(Boolean);
        return '<li><span class="doc-ico">' + PERSON_ICON + '</span>' +
          '<span class="doc-meta"><span class="n">' + esc(c.name || email) + '</span>' +
          '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
          '<span class="contact-actions"><a href="#" class="doc-dl" data-pick-match="' + i + '">Select</a></span></li>';
      }).join("");
      $("inviteMatchesList").onclick = function (e) {
        var a = e.target && e.target.closest ? e.target.closest("[data-pick-match]") : null;
        if (!a) return;
        e.preventDefault();
        chooseMatch(email, clients[Number(a.getAttribute("data-pick-match"))]);
      };
      form.hidden = true; matchesBox.hidden = false;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("inviteMsg"); msg.className = "portal-msg"; msg.textContent = "";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var email = $("ivEmail").value.trim();
      nameOverride = $("ivName").value.trim();
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; msg.textContent = "Looking up this client in Bindly…";
      AdminData.lookupClient(email).then(function (res) {
        var clients = (res && res.clients) || [];
        if (clients.length === 0) {
          msg.className = "portal-msg err";
          msg.textContent = "No Bindly client found for that email. Double-check it, or confirm which email is on file with the client.";
        } else if (clients.length === 1) {
          msg.textContent = "";
          chooseMatch(email, clients[0]);
        } else {
          msg.textContent = "";
          renderMatches(email, clients);
        }
      }).catch(function (err) {
        msg.className = "portal-msg err";
        msg.textContent = err && err.message ? err.message : "Couldn’t look up this client — try again.";
      }).finally(function () { btn.disabled = false; });
    });

    $("inviteMatchesBackBtn").addEventListener("click", resetToForm);
    $("inviteBackBtn").addEventListener("click", resetToForm);

    $("inviteSendBtn").addEventListener("click", function () {
      if (!pending) return;
      var typeSel = $("ivConfirmType");
      if (typeSel) pending.accountType = typeSel.value === "commercial" ? "commercial" : "personal";
      var cmsg = $("inviteConfirmMsg"); cmsg.className = "portal-msg"; cmsg.textContent = "Sending…";
      var btn = $("inviteSendBtn"); btn.disabled = true;
      AdminData.invite(pending).then(function (res) {
        if (res && res.ok) {
          resetToForm(); form.reset();
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
      // A resend actually revokes the old invite and creates a fresh one with a
      // NEW id, so reload the list on success — otherwise the row on screen
      // keeps the dead id and a later Revoke/Resend on it fails.
      if (row) AdminData.resend(row)
        .then(function () { showToast("Invite re-sent to " + row.email + "."); loadUsers(); })
        .catch(function (err) { showToast(err && err.message ? err.message : "Couldn’t re-send that invite — try again."); });
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
    siteHeader(false);
    // Team management is admin-only (staff can only manage clients).
    adminIsAdmin = !!(user && user.role === "admin");
    adminSelfId = (user && user.id) || null;
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
    siteHeader(false);

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
        siteHeader(true);
        if (loginForm) loginForm.reset();
        window.scrollTo(0, 0);
      });
    });
  }

  // ---- Auth bootstrap ----
  function initAuth() {
    var ticket = getClerkTicket();
    if (CLERK_ENABLED) { initClerk(ticket); if (STAFF_ENTRY && !ticket) applyStaffCopy(); return; }
    // No Clerk key configured — sign-in can't run. Leave the login form visible;
    // its submit handler reports that sign-in is temporarily unavailable rather
    // than ever collecting a password with no backend behind it.
    hideBoot();
    if (loginView) loginView.hidden = false;
    if (STAFF_ENTRY) applyStaffCopy();
  }

  // ---- Real auth via Clerk (native IPG form) ----
  // Clerk (loaded async in index.html) owns identity, passwords, MFA, and
  // sessions — but we drive it through the site's OWN login form below via
  // Clerk's headless API, so sign-in looks native instead of Clerk's floating
  // card. On success we hold a Clerk session; every future API call (Phase 2)
  // sends its JWT as a Bearer token, and the server re-derives the client id +
  // account type from that VERIFIED token, never trusting the browser.
  // onTimeout fires if window.Clerk never shows up (~6s) — without it the boot
  // spinner would spin forever instead of falling back to the login form.
  function whenClerkReady(cb, onTimeout) {
    if (window.Clerk) return cb();
    var tries = 0;
    var t = setInterval(function () {
      if (window.Clerk) { clearInterval(t); cb(); }
      else if (++tries > 120) { clearInterval(t); if (onTimeout) onTimeout(); } // ~6s, then give up
    }, 50);
  }

  function showLoginUnavailable() {
    hideBoot();
    if (loginView) loginView.hidden = false;
    var sub = $("loginSub");
    if (sub) sub.textContent = "Sign-in is temporarily unavailable. Please try again shortly.";
  }

  function initClerk(ticket) {
    whenClerkReady(function () {
      window.Clerk.load().then(function () {
        // While finishing an invite (setting a password), don't let Clerk's
        // change listener flash the login screen underneath.
        window.Clerk.addListener(function () { if (!inAcceptFlow) renderAuthState(); });
        if (ticket) { startAcceptFlow(ticket); return; }
        renderAuthState();
      }).catch(showLoginUnavailable);
    }, showLoginUnavailable);
  }

  // ---- Accept an invite natively (set your password on ipg.team) ----
  function showAcceptView() {
    hideBoot();
    if (loginView) loginView.hidden = true;
    if (appView) appView.hidden = true;
    if (acceptView) acceptView.hidden = false;
    siteHeader(true);
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
    hideBoot();
    var Clerk = window.Clerk;
    if (Clerk && Clerk.user) {
      // Signed in — build the client context. The browser reads publicMetadata
      // only to choose which view to show; authorization is still enforced
      // server-side off the verified Clerk JWT.
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
      siteHeader(true);
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

  // Local-dev hook (localhost only) for exercising the invite-accept UI and
  // poking the live data layers from the console. Not defined on the live domain.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.__portalDebug = { data: PortalData, reload: loadDashboard, admin: AdminData,
      showAccept: function () { showAcceptView(); var f = $("acEmail"); if (f) f.value = "teammate@ipg.team"; } };
  }
})();
