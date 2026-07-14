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
    // Non-standard request (a description of operations was given) — creates
    // a Bindly Service Center ticket for agent review instead of issuing
    // instantly. Returns { ok, status: "pending", holder }.
    requestCoi: function (data) {
      return authedApi("/portal-coi-requests", { method: "POST", body: data });
    },
    // GET profile -> { name, company, email, phone, address, masterCoi }.
    // masterCoi (or null) is Bindly's approval record for the master
    // certificate — the single source of truth for that document, entirely
    // separate from the /portal-documents listing.
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
    // Route a "request a change" to IPG's service team. Body: { topic, message }.
    submitServiceRequest: function (data) {
      return authedApi("/portal-service-request", { method: "POST", body: data });
    },
    isCommercial: function () { return this._type === "commercial"; },
    logout: function () { return Promise.resolve(); }
  };

  // Local view state. Holders added in-session live here. docsLoadedAt tracks
  // when the document listing (with its 15-minute signed URLs) was fetched, so
  // download clicks know whether the links are still fresh.
  var state = { policies: [], holders: [], commercial: false, contacts: [], documents: [], masterCoi: null, clerkName: "", clerkHasRealName: false, docsLoadedAt: 0 };
  function clearClientState() {
    state.policies = []; state.holders = []; state.contacts = []; state.documents = [];
    state.masterCoi = null;
    state.docsLoadedAt = 0;
  }

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
          if (!r.ok) {
            // 401 mid-session means the login expired — say that in plain
            // English instead of surfacing a raw "Request failed (401)".
            if (r.status === 401) throw new Error("Your session has ended — please refresh the page and sign in again.");
            throw new Error(body.error || ("Request failed (" + r.status + ")"));
          }
          return body;
        });
      });
    });
  }

  var AdminData = {
    load: function () {
      return authedApi("/portal-admin-users").then(function (b) { return { users: b.users || [], team: b.team || [] }; });
    },
    // Find the Bindly client(s) matching a query — an email (classic invite)
    // or a company/person name (the "add a person to an existing company"
    // flow) — instead of asking staff to type a Bindly client id by hand.
    lookupClient: function (q) {
      return authedApi("/portal-admin-users", { method: "POST", body: { action: "lookup", q: q } });
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
    },
    // Self-service: the phone/email shown on a client's Producer/CSR card
    // when Bindly names the caller in that role.
    getMyProfile: function () {
      return authedApi("/portal-staff-profile");
    },
    updateMyProfile: function (data) {
      return authedApi("/portal-staff-profile", { method: "PUT", body: data });
    }
  };

  // =====================================================================
  // Helpers + UI
  // =====================================================================
  var FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  var PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/></svg>';
  var CARET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  // Short abbreviation shown in a policy card's icon chip (e.g. "General
  // Liability" -> "GL", "Workers Compensation" -> "WC"). Falls back to the
  // first two letters for single-word lines.
  function policyAbbrev(type) {
    var words = String(type || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "•";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return words.slice(0, 3).map(function (w) { return w[0]; }).join("").toUpperCase();
  }

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
    // The category is shown as the group heading, so the row only needs the
    // cleaned name + date. data-dl-doc lets the download handler re-fetch a
    // fresh signed URL if this one has gone stale (they expire in ~15 min);
    // target=_blank keeps the PDF from replacing the portal tab.
    var idx = state.documents.indexOf(d);
    return '<li><span class="doc-ico">' + FILE_ICON + '</span>' +
      '<span class="doc-meta"><span class="n">' + esc(cleanDocName(d.name)) + '</span>' +
      (d.date ? '<span class="m">' + esc(d.date) + '</span>' : '') + '</span>' +
      '<a class="doc-dl" href="' + esc(d.url || "#") + '"' +
      (d.url && d.url !== "#" ? ' data-dl-doc="' + idx + '" target="_blank" rel="noopener"' : '') +
      '>Download</a></li>';
  }
  function renderDocs(el, items, emptyText) {
    if (!el) return;
    el.innerHTML = (items && items.length)
      ? items.map(docItem).join("")
      : '<li class="doc-empty">' + esc(emptyText || "Nothing here yet.") + '</li>';
  }

  // Documents grouped by Bindly category, in a sensible order, with a live
  // search box that filters by document name. Renders into #docGroups.
  var DOC_CATEGORY_ORDER = ["Policies", "ID Cards", "Declarations", "Dec Pages",
    "COIs", "Cert Holders", "Loss Runs", "Quotes", "ACORD Apps", "Documents", "Miscellaneous"];
  function docCategoryRank(cat) {
    var i = DOC_CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? DOC_CATEGORY_ORDER.length : i;
  }
  // Client-friendly display names for Bindly's internal category labels (the
  // headings render uppercase, so "COIs" would read as the typo-ish "COIS").
  var DOC_CATEGORY_LABELS = { "COIs": "Certificates", "Cert Holders": "Issued Certificates", "Dec Pages": "Declarations" };
  function docCategoryLabel(cat) { return DOC_CATEGORY_LABELS[cat] || cat; }
  // Within a type group, newest year first. `year` comes from the backend
  // (derived from Bindly's `modified` date — the closest proxy available
  // until Bindly can expose a real policy-term year; see portal-documents.js).
  // Anything without a parseable date lands in "Undated" at the end rather
  // than being dropped or mixed in with real years.
  function renderYearGroups(items) {
    var byYear = {};
    items.forEach(function (d) {
      var y = d.year || "Undated";
      (byYear[y] = byYear[y] || []).push(d);
    });
    var years = Object.keys(byYear).sort(function (a, b) {
      if (a === "Undated") return 1;
      if (b === "Undated") return -1;
      return Number(b) - Number(a);
    });
    return years.map(function (y) {
      return '<div class="doc-year-group">' +
        '<div class="doc-year-head">' + esc(y) + '</div>' +
        '<ul class="doc-list">' + byYear[y].map(docItem).join("") + '</ul>' +
      '</div>';
    }).join("");
  }
  function renderDocGroups(filter) {
    var wrap = $("docGroups");
    if (!wrap) return;
    var q = (filter || "").trim().toLowerCase();
    var docs = state.documents.filter(function (d) {
      return !q || (cleanDocName(d.name) + " " + (d.name || "") + " " + (d.kind || "") + " " +
        docCategoryLabel(d.kind || "") + " " + (d.year || "")).toLowerCase().indexOf(q) > -1;
    });
    if (!docs.length) {
      wrap.innerHTML = '<ul class="doc-list"><li class="doc-empty">' +
        (state.documents.length ? 'No documents match “' + esc(filter) + '”.' : 'No documents on file yet.') +
        '</li></ul>';
      return;
    }
    // Bucket by category, preserving first-seen order within each.
    var groups = {};
    docs.forEach(function (d) {
      var cat = d.kind || "Documents";
      (groups[cat] = groups[cat] || []).push(d);
    });
    var cats = Object.keys(groups).sort(function (a, b) {
      var r = docCategoryRank(a) - docCategoryRank(b);
      return r !== 0 ? r : a.localeCompare(b);
    });
    wrap.innerHTML = cats.map(function (cat) {
      return '<div class="doc-group">' +
        '<div class="doc-group-head"><span class="lbl">' + esc(docCategoryLabel(cat)) + '</span>' +
          '<span class="cnt">' + groups[cat].length + '</span></div>' +
        renderYearGroups(groups[cat]) +
      '</div>';
    }).join("");
  }
  function initDocSearch() {
    var input = $("docSearch");
    if (!input) return;
    input.addEventListener("input", function () { renderDocGroups(input.value); });
  }

  function statusBadge(status) {
    // Policy statuses come straight from Bindly's authoritative `status`
    // field (active/expired/pending/unknown); issued certs are "issued".
    // (The old "received"/"in review" cert states went away with the
    // review-routed cert flow — every holder issues instantly.)
    var map = {
      active: ["active", "Active"], issued: ["issued", "Issued"],
      expired: ["expired", "Expired"], cancelled: ["expired", "Cancelled"], pending: ["pending", "Pending"],
      // "review": a cert-holder-only status (see renderHolders) — distinct
      // from a POLICY's "pending" (not yet effective), which shares this map.
      review: ["pending", "Pending review"]
    };
    var m = map[status] || ["pending", cap(status) || ""];
    return '<span class="badge ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  // The renewal chip: amber "Renews in X days" when a policy is renewing soon
  // (turns red inside 14 days), otherwise a quiet "Renews {Mon YYYY}" — or
  // nothing if we have no date. Skipped entirely for expired policies.
  function renewalChip(p) {
    if (p.status === "expired" || p.status === "cancelled") return "";
    var d = p.daysToRenew;
    if (p.renewsSoon && typeof d === "number" && d >= 0) {
      var urgent = d <= 14 ? " urgent" : "";
      var txt = d === 0 ? "Renews today" : d === 1 ? "Renews in 1 day" : "Renews in " + d + " days";
      return '<span class="chip renew' + urgent + '">' + esc(txt) + '</span>';
    }
    if (p.expiration) return '<span class="chip neutral">Renews ' + esc(p.expiration) + '</span>';
    return "";
  }

  function renderPolicies() {
    var el = $("policyList");
    if (!el) return;
    var disc = $("policyDisclaimer");
    if (disc) disc.hidden = !state.policies.length;
    if (!state.policies.length) {
      el.innerHTML = '<li class="doc-empty">No policies on file.</li>';
      return;
    }
    el.innerHTML = state.policies.map(function (p, i) {
      var meta = [p.carrier, p.number ? "#" + p.number : ""].filter(Boolean).join(" · ");
      var body;
      if (p.coverages && p.coverages.length) {
        body = '<div class="pcov-grid">' + p.coverages.map(function (c) {
          return '<div class="pcov-item"><span class="k">' + esc(c.label) + '</span><span class="v">' + esc(c.value) + '</span></div>';
        }).join("") + '</div>';
      } else {
        body = '<p class="pcov-empty">Coverage details aren’t available online for this policy — see your declarations page in Documents, or call us.</p>';
      }
      if (p.term) body += '<div class="policy-term">Policy term: ' + esc(p.term) + '</div>';
      return '<li class="policy-card" data-policy="' + i + '"' + (p.renewsSoon ? ' data-renewing="1"' : '') + '>' +
          '<button class="policy-summary" type="button" aria-expanded="false">' +
            '<span class="policy-icon">' + esc(policyAbbrev(p.type)) + '</span>' +
            '<span class="policy-info"><span class="n">' + esc(p.type) + '</span>' +
              (meta ? '<span class="m">' + esc(meta) + '</span>' : '') + '</span>' +
            '<span class="policy-tags">' + renewalChip(p) + statusBadge(p.status) + '</span>' +
            '<span class="policy-caret">' + CARET_ICON + '</span>' +
          '</button>' +
          '<div class="policy-body" hidden>' + body + '</div>' +
        '</li>';
    }).join("");
  }

  // Expand/collapse a policy card (event-delegated so it survives re-renders).
  function initPolicyCards() {
    var list = $("policyList");
    if (!list) return;
    list.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".policy-summary") : null;
      if (!btn) return;
      var card = btn.closest(".policy-card");
      var body = card.querySelector(".policy-body");
      var open = card.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (body) body.hidden = !open;
    });
  }

  // Clicking the "Renewing soon" stat scrolls to the policy list and expands
  // the policies that are actually renewing, with a brief highlight.
  function revealRenewing() {
    activateTab("overview");
    var cards = document.querySelectorAll('.policy-card[data-renewing="1"]');
    if (!cards.length) return;
    cards.forEach(function (card) {
      card.classList.add("open", "flash");
      var btn = card.querySelector(".policy-summary");
      var body = card.querySelector(".policy-body");
      if (btn) btn.setAttribute("aria-expanded", "true");
      if (body) body.hidden = false;
      setTimeout(function () { card.classList.remove("flash"); }, 1700);
    });
    cards[0].scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderHolders() {
    var el = $("holderList");
    if (!el) return;
    el.innerHTML = state.holders.length ? state.holders.map(function (h, i) {
      var bits = [h.address, h.date].filter(Boolean);
      var actions = '<span class="contact-actions">';
      // Re-issue prefills the add-holder form with this holder so the client
      // can get a fresh dated certificate (e.g. at renewal) without retyping.
      // Not offered for a request still under review — there's no issued
      // certificate yet to base a re-issue on.
      if (h.status !== "review") {
        actions += '<a href="#" class="doc-dl" data-reissue="' + i + '">Re-issue</a>';
      }
      if (h.status === "issued" && h.url && h.url !== "#") {
        actions += '<a class="doc-dl" href="' + esc(h.url) + '" data-dl-holder="' + i + '" target="_blank" rel="noopener">Download</a>';
      }
      actions += '</span>';
      return '<li><span class="doc-ico">' + FILE_ICON + '</span>' +
        '<span class="doc-meta"><span class="n">' + esc(h.name) + '</span>' +
        '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
        statusBadge(h.status) + actions + '</li>';
    }).join("") : '<li class="doc-empty">No certificate holders yet.</li>';
  }

  // Master COI card at the top of the Certificates tab — the client's overall
  // certificate of insurance (as opposed to a holder-specific cert). Sourced
  // ONLY from Bindly's master_coi approval record (via PortalData.getAccount,
  // state.masterCoi) — deliberately NOT from the documents listing, which no
  // longer carries it at all. Hidden entirely unless Bindly has approved one.
  function renderMasterCoi() {
    var card = $("masterCoiCard");
    if (!card) return;
    var mc = state.masterCoi;
    if (!mc || !mc.approved || !mc.url) { card.hidden = true; return; }
    var bits = [];
    if (mc.approvedBy) bits.push("Approved by " + mc.approvedBy);
    if (mc.approvedAt) bits.push(fmtDate(mc.approvedAt));
    $("masterCoiMeta").textContent = bits.join(" · ");
    var staleBadge = $("masterCoiStale");
    if (staleBadge) staleBadge.hidden = !mc.stale;
    // masterCoiLink is a plain button now — see initDocPreview for the
    // in-page preview it opens (via portal-doc-proxy.js, resolved fresh
    // server-side each click, not this mc.url).
    card.hidden = false;
  }

  function updateStats() {
    // "Active policies" counts only policies that are actually active.
    var activeCount = state.policies.filter(function (p) { return p.status === "active"; }).length;
    $("statPolicies").textContent = activeCount;
    var thirdCard = $("statThird").parentNode;
    thirdCard.removeAttribute("data-goto");
    thirdCard.removeAttribute("data-renew-stat");
    thirdCard.removeAttribute("role");
    thirdCard.removeAttribute("tabindex");
    function makeCardClickable() { thirdCard.setAttribute("role", "button"); thirdCard.setAttribute("tabindex", "0"); }
    if (state.commercial) {
      // Every holder issues instantly now — show the running certificate count.
      $("statThirdLbl").textContent = "Certificates issued";
      $("statThird").textContent = state.holders.length;
      thirdCard.setAttribute("data-goto", "certificates");
      makeCardClickable();
    } else {
      // Personal clients care about upcoming renewals instead. Clicking the
      // card jumps to (and expands) the policies that are renewing.
      var soon = state.policies.filter(function (p) { return p.renewsSoon; }).length;
      $("statThirdLbl").textContent = "Renewing soon";
      $("statThird").textContent = soon;
      if (soon > 0) { thirdCard.setAttribute("data-renew-stat", "1"); makeCardClickable(); }
    }
  }

  // Corrects the header/greeting once the real Bindly profile loads —
  // showDashboard's initial paint only has the Clerk login name/email to go
  // on. Personal: use the client's real name. Commercial: the small header
  // name is the business name, and the big "Welcome" greeting prefers the
  // actual logged-in person's name (Bindly's name field is the business
  // contact, which may not be who's signed in) — but falls back to that
  // Bindly contact name instead of a raw login email when Clerk has no
  // name on file for this user.
  function updateHeaderName(account) {
    if (!account) return;
    var personal = account.name || state.clerkName;
    var commercialWelcome = state.clerkHasRealName ? state.clerkName : (account.name || state.clerkName);
    var pUser = $("pUser"), pWelcome = $("pWelcome");
    if (pUser) pUser.textContent = state.commercial ? (account.company || personal) : personal;
    if (pWelcome) pWelcome.textContent = "Welcome, " + (state.commercial ? commercialWelcome : personal) + ".";
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
    renderPersonCard("producerCard", "Your Producer", a.producer);
    // csrs is [primary CSR, ...additional_csrs] with nulls already filtered
    // server-side — the primary CSR being unassigned doesn't hide a real
    // secondary one, so this always reflects whoever's actually on file.
    renderPersonCard("csrCard", "Your CSR", a.csrs);
  }

  function personRow(person) {
    var initials = person.name.trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
    var links = [];
    if (person.phone) links.push('<a href="tel:' + esc(person.phone.replace(/[^\d+]/g, "")) + '">' + esc(person.phone) + '</a>');
    if (person.email) links.push('<a href="mailto:' + esc(person.email) + '">' + esc(person.email) + '</a>');
    return '<span class="agent-row">' +
      '<span class="agent-avatar">' + esc(initials || "IPG") + '</span>' +
      '<span class="agent-meta"><span class="name">' + esc(person.name) + '</span>' +
      (links.length ? '<span class="agent-links">' + links.join("") + '</span>' : '') +
      '</span></span>';
  }

  // Assigned-person card (Producer, CSR) — only shown when Bindly has that
  // role set on the account. Accepts one person or an array (a CSR card can
  // carry a primary plus any additional_csrs as extra rows). No one assigned
  // means no card at all, not an empty one.
  function renderPersonCard(elId, roleLabel, people) {
    var card = $(elId);
    if (!card) return;
    var list = (Array.isArray(people) ? people : [people]).filter(function (p) { return p && p.name; });
    if (!list.length) { card.hidden = true; card.innerHTML = ""; return; }
    card.innerHTML = '<span class="role">' + esc(roleLabel) + '</span>' + list.map(personRow).join("");
    card.hidden = false;
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
      submitBtn.textContent = id ? "Saving…" : "Adding…";
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
      }).catch(function (err) {
        // A failed save must never look like a success — say what happened.
        msg.className = "portal-msg err";
        msg.textContent = (err && err.message) || "We couldn’t save that contact. Please try again.";
      }).finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = $("cId").value ? "Save changes" : "Add contact";
      });
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
          }).catch(function (err) {
            showToast((err && err.message) || "We couldn’t remove that contact — please try again.");
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
          a.hasAttribute("data-users-retry") || a.hasAttribute("data-pick-match") || a.hasAttribute("data-reissue")) return;
      e.preventDefault();
      showToast("This document isn’t available for download online — call us at (214) 377-1460 and we’ll send it over.");
    });
  }

  // ---- Fresh download links ----
  // Bindly's signed document URLs expire ~15 minutes after the listing loads.
  // If a client clicks Download on a page that's been open longer than that,
  // the link would land on a raw error page — so the click re-fetches the
  // listing for a fresh URL first. The new tab is opened SYNCHRONOUSLY (before
  // the fetch) so popup blockers allow it.
  var FRESH_WINDOW_MS = 13 * 60 * 1000; // refresh with a ~2 min safety margin
  function initFreshDownloads() {
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[data-dl-doc], a[data-dl-holder]") : null;
      if (!a) return;
      var isDoc = a.hasAttribute("data-dl-doc");
      // Links are still fresh — let the browser follow them normally.
      if (state.docsLoadedAt && (Date.now() - state.docsLoadedAt) < FRESH_WINDOW_MS) return;
      e.preventDefault();
      var win = window.open("", "_blank"); // must be synchronous with the click
      var idx = Number(a.getAttribute(isDoc ? "data-dl-doc" : "data-dl-holder"));
      var stale = isDoc ? state.documents[idx] : state.holders[idx];
      var refresh = isDoc
        ? PortalData.getDocuments().then(function (docs) {
            state.documents = docs || [];
            state.docsLoadedAt = Date.now();
            var search = $("docSearch");
            renderDocGroups(search ? search.value : "");
            // Match the clicked row back up by name + category.
            var m = state.documents.filter(function (d) {
              return stale && d.name === stale.name && d.kind === stale.kind;
            })[0];
            return (m && m.url) || (stale && stale.url) || "";
          })
        : PortalData.getHolders().then(function (holders) {
            state.holders = holders || [];
            renderHolders(); updateStats();
            var m = state.holders.filter(function (h) {
              return stale && (h.id ? h.id === stale.id : h.name === stale.name);
            })[0];
            return (m && m.url) || (stale && stale.url) || "";
          });
      refresh.then(function (url) {
        if (url && url !== "#") { win.location = url; }
        else { win.close(); showToast("That document isn’t available right now — try refreshing the page."); }
      }).catch(function () {
        // Couldn't refresh — fall back to the (possibly stale) original link.
        if (stale && stale.url && stale.url !== "#") win.location = stale.url;
        else { win.close(); showToast("That download didn’t work — try refreshing the page."); }
      });
    });
  }

  // ---- In-page document preview ----
  // Bindly's PDF responses carry X-Frame-Options: SAMEORIGIN, so their signed
  // URLs can't be embedded in an <iframe> on ipg.team. portal-doc-proxy.js
  // fetches the bytes server-side and re-serves them from our own origin
  // instead — this pulls them via fetch() (so the Bearer token still works,
  // unlike a plain <iframe src>) and hands the iframe a blob: URL.
  function initDocPreview() {
    var modal = $("docPreviewModal");
    var frame = $("docPreviewFrame");
    var msg = $("docPreviewMsg");
    var title = $("docPreviewTitle");
    if (!modal || !frame || !msg) return;
    var currentObjectUrl = null;

    function closePreview() {
      modal.hidden = true;
      frame.hidden = true;
      frame.src = "about:blank";
      if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    }

    function openPreview(doc, label) {
      modal.hidden = false;
      frame.hidden = true;
      msg.hidden = false;
      msg.textContent = "Loading…";
      if (title) title.textContent = label || "Preview";
      getToken().then(function (tok) {
        var headers = {};
        if (tok) headers["Authorization"] = "Bearer " + tok;
        return fetch(PORTAL_CONFIG.apiBase + "/portal-doc-proxy?doc=" + encodeURIComponent(doc), { headers: headers });
      }).then(function (r) {
        if (!r.ok) throw new Error("preview failed");
        return r.blob();
      }).then(function (blob) {
        currentObjectUrl = URL.createObjectURL(blob);
        // #navpanes=0 hides the browser PDF viewer's thumbnail sidebar so the
        // certificate itself gets the full width — a standard PDF open
        // parameter honored by Chrome/Edge's built-in viewer.
        frame.src = currentObjectUrl + "#navpanes=0";
        frame.hidden = false;
        msg.hidden = true;
      }).catch(function () {
        msg.textContent = "Couldn’t load the preview — try again, or use Download instead.";
      });
    }

    modal.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("[data-close-preview]")) closePreview();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closePreview();
    });

    var masterBtn = $("masterCoiLink");
    if (masterBtn) {
      masterBtn.addEventListener("click", function () {
        openPreview("master-coi", "Master Certificate of Insurance");
      });
    }
  }

  // ---- Tabs ----
  function activateTab(name) {
    document.querySelectorAll(".ptab").forEach(function (x) {
      var on = x.getAttribute("data-tab") === name;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
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
    // The clickable stat cards are divs, so make Enter/Space work for
    // keyboard users too (they carry role="button" + tabindex).
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var el = e.target && e.target.closest ? e.target.closest(".stat-card[data-goto], .stat-card[data-renew-stat]") : null;
      if (!el) return;
      e.preventDefault();
      if (el.hasAttribute("data-goto")) activateTab(el.getAttribute("data-goto"));
      else revealRenewing();
    });
  }

  // Best-effort split of a stored display address ("100 Main St, Suite 4,
  // Dallas, TX 75201") back into the form fields for Re-issue. Anything we
  // can't confidently parse is left for the client to confirm before issuing.
  function parseHolderAddress(addr) {
    var out = { address1: "", address2: "", city: "", state: "", zip: "" };
    if (!addr) return out;
    var m = /^(.*?),\s*([^,]+),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)\s*$/.exec(addr.trim());
    if (m) {
      out.address1 = m[1].trim();
      out.city = m[2].trim();
      out.state = m[3].toUpperCase();
      out.zip = m[4];
    } else {
      out.address1 = addr.trim(); // couldn't parse cleanly — client fills the rest
    }
    return out;
  }

  // ---- Add a certificate holder (self-service, or a reviewed request) ----
  function initHolderForm() {
    var form = $("holderForm");
    if (!form) return;
    var msg = $("holderMsg");
    var descField = $("hDesc");
    var descAlert = $("hDescAlert");

    // A description of operations means this ISN'T a standard instant cert —
    // it needs an IPG agent's review (see coi-request modal below).
    if (descField && descAlert) {
      descField.addEventListener("input", function () {
        descAlert.hidden = !descField.value.trim();
      });
    }

    function submit(data) {
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Issuing…"; }
      PortalData.addHolder(data).then(function (res) {
        if (res && res.ok) {
          state.holders.unshift(res.holder);
          renderHolders(); updateStats();
          form.reset();
          if (descAlert) descAlert.hidden = true;
          msg.className = "portal-msg ok";
          msg.textContent = "Certificate issued — download it from the list below.";
        }
      }).catch(function (err) {
        msg.className = "portal-msg err";
        msg.textContent = (err && err.message) || "We couldn’t issue that certificate. Please try again.";
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Add holder"; }
      });
    }

    // ---- Description-of-operations request: email + notes popup ----
    var coiModal = $("coiRequestModal");
    var coiForm = $("coiRequestForm");
    var coiMsg = $("coiRequestMsg");
    var pendingCoi = null; // { data, description } captured from the main form

    function openCoiModal(data, description) {
      pendingCoi = { data: data, description: description };
      if (coiForm) coiForm.reset();
      if (coiMsg) { coiMsg.className = "portal-msg"; coiMsg.textContent = ""; }
      if (coiModal) coiModal.hidden = false;
      var email = $("crEmail"); if (email) email.focus();
    }
    function closeCoiModal() { if (coiModal) coiModal.hidden = true; pendingCoi = null; }

    if (coiModal) {
      coiModal.addEventListener("click", function (e) {
        if (e.target && e.target.closest && e.target.closest("[data-close-coi]")) closeCoiModal();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !coiModal.hidden) closeCoiModal();
      });
    }
    if (coiForm) {
      coiForm.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!pendingCoi) return;
        if (!coiForm.checkValidity()) { coiForm.reportValidity(); return; }
        var payload = {
          name: pendingCoi.data.name, address1: pendingCoi.data.address1,
          address2: pendingCoi.data.address2, city: pendingCoi.data.city,
          state: pendingCoi.data.state, zip: pendingCoi.data.zip,
          description_of_operations: pendingCoi.description,
          email: $("crEmail").value.trim(),
          notes: $("crNotes") ? $("crNotes").value.trim() : ""
        };
        var btn = coiForm.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
        PortalData.requestCoi(payload).then(function (res) {
          if (res && res.ok) {
            state.holders.unshift(res.holder);
            renderHolders(); updateStats();
            closeCoiModal();
            form.reset();
            if (descAlert) descAlert.hidden = true;
            msg.className = "portal-msg ok";
            msg.textContent = "Request submitted for review — we’ll email the certificate once it’s approved.";
          }
        }).catch(function (err) {
          coiMsg.className = "portal-msg err";
          coiMsg.textContent = (err && err.message) || "We couldn’t submit that request. Please try again.";
        }).finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = "Submit request"; }
        });
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "portal-msg";
      msg.textContent = "";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var data = {
        name: $("hName").value.trim(),
        address1: $("hAddr1").value,
        address2: $("hAddr2").value,
        city: $("hCity").value,
        state: $("hState").value,
        zip: $("hZip").value
      };
      var description = descField ? descField.value.trim() : "";
      // Warn on a duplicate holder name so the client doesn't issue two certs
      // for the same holder by accident (re-issue at renewal is a real case,
      // so we confirm rather than block).
      var dupe = state.holders.some(function (h) {
        return (h.name || "").trim().toLowerCase() === data.name.toLowerCase();
      });
      if (dupe && !window.confirm('A certificate for “' + data.name + '” already exists. Issue another one?')) return;
      if (description) { openCoiModal(data, description); return; }
      submit(data);
    });

    // Re-issue: prefill the form from an existing holder and jump to it.
    var list = $("holderList");
    if (list) {
      list.addEventListener("click", function (e) {
        var a = e.target && e.target.closest ? e.target.closest("[data-reissue]") : null;
        if (!a) return;
        e.preventDefault();
        var h = state.holders[Number(a.getAttribute("data-reissue"))];
        if (!h) return;
        var p = parseHolderAddress(h.address);
        $("hName").value = h.name || "";
        $("hAddr1").value = p.address1;
        $("hAddr2").value = p.address2;
        $("hCity").value = p.city;
        $("hState").value = p.state;
        $("hZip").value = p.zip;
        msg.className = "portal-msg";
        msg.textContent = "Review the details below, then Add holder to issue a fresh certificate.";
        form.scrollIntoView({ behavior: "smooth", block: "center" });
        $("hName").focus();
      });
    }
  }

  // ---- Service: request a change ----
  function initServiceForm() {
    var form = $("serviceForm");
    if (!form) return;
    var msg = $("svcMsg");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "portal-msg";
      msg.textContent = "";
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var data = { topic: $("svcTopic").value, message: $("svcMessage").value.trim() };
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      PortalData.submitServiceRequest(data).then(function (res) {
        if (res && res.ok) {
          form.reset();
          msg.className = "portal-msg ok";
          msg.textContent = "Thanks — your request is in. Your IPG service team will follow up shortly.";
        }
      }).catch(function (err) {
        msg.className = "portal-msg err";
        msg.textContent = (err && err.message) || "We couldn’t send that just now. Please call (214) 377-1460.";
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Send request"; }
      });
    });
  }

  // ---- Dashboard data (loading / loaded / failed) ----
  // The mock resolves instantly, but real Bindly-backed calls won't — and one
  // failed request must never leave a client staring at silently-empty panels.
  function setDashboardLoading() {
    // Drop any previous data immediately — a failed reload must never leave
    // the last user's documents re-renderable (e.g. via the search box).
    clearClientState();
    ["policyList", "holderList", "contactList"].forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = '<li class="doc-empty">Loading…</li>';
    });
    var groups = $("docGroups");
    if (groups) groups.innerHTML = '<ul class="doc-list"><li class="doc-empty">Loading…</li></ul>';
    var grid = $("acctGrid");
    if (grid) grid.innerHTML = '<div class="doc-empty">Loading…</div>';
    $("statPolicies").textContent = "—";
    $("statDocs").textContent = "—";
    $("statThird").textContent = "—";
  }
  function setDashboardError() {
    var retry = 'Couldn’t load this — <a href="#" class="doc-dl" data-retry>try again</a>.';
    ["policyList", "holderList", "contactList"].forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = '<li class="doc-empty">' + retry + '</li>';
    });
    var groups = $("docGroups");
    if (groups) groups.innerHTML = '<ul class="doc-list"><li class="doc-empty">' + retry + '</li></ul>';
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
      state.documents = r[1] || [];
      state.holders = r[2] || [];
      state.contacts = r[4] || [];
      state.masterCoi = (r[3] && r[3].masterCoi) || null;
      state.docsLoadedAt = Date.now();
      $("statDocs").textContent = state.documents.length;
      renderPolicies();
      var search = $("docSearch"); if (search) search.value = "";
      renderDocGroups("");
      renderHolders();
      renderMasterCoi();
      renderAccount(r[3]);
      renderContacts();
      updateStats();
      updateHeaderName(r[3]);
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
  // Clicking the "Renewing soon" stat card reveals the renewing policies.
  document.addEventListener("click", function (e) {
    var card = e.target && e.target.closest ? e.target.closest("[data-renew-stat]") : null;
    if (card) revealRenewing();
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

  // The "+ Add login" link that opens the invite modal already in attach
  // mode for THIS specific client — skips the company search step entirely
  // (see openAttachFor in initInviteForm). Client rows only, never team.
  function addLoginLink(u) {
    return '<a href="#" class="doc-dl" data-add-login="' + esc(u.bindly_client_id || "") +
      '" data-add-login-type="' + esc(u.account_type || "personal") +
      '" data-add-login-name="' + esc(u.name || "") + '">+ Add login</a>';
  }

  // One list-row for either a client login or a team member. Client rows only
  // ever appear inside a client-shell now (see shellHtml) — the shell header
  // carries the single "+ Add login" action for the whole account.
  //
  // companyName (client rows only): the shell header already shows the
  // company name once. Commercial accounts invited before there was a
  // separate "person's name" field (the classic invite flow's Name field is
  // just an optional override) have their login's name stored as Bindly's
  // company name — so without this, that row would repeat the company name
  // as if it were the person's. When it's an exact duplicate, show the email
  // as the primary identifier instead rather than repeating the company name.
  function rowHtml(u, isTeam, companyName) {
    var isCompanyNameDupe = !isTeam && u.account_type === "commercial" &&
      companyName && u.name && u.name === companyName;
    var displayName = isCompanyNameDupe ? "" : u.name;
    var bits = isTeam
      ? [ u.name ? u.email : "", cap(u.role), fmtDate(u.created) ].filter(Boolean)
      : [ displayName ? u.email : "", cap(u.account_type), fmtDate(u.created) ].filter(Boolean);
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
      '<span class="doc-meta"><span class="n">' + esc(displayName || u.email) + '</span>' +
      '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
      statusPill(u.status) + actions + '</li>';
  }

  // Groups logins sharing the same bindly_client_id — a company with several
  // people (the "add a person to an existing company" flow) gets ONE shell
  // instead of N disconnected rows. Order preserved by first appearance.
  function groupUsers(users) {
    var order = [], groups = {};
    users.forEach(function (u) {
      var key = u.bindly_client_id || ("solo:" + u.id);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(u);
    });
    return order.map(function (key) { return groups[key]; });
  }

  // The shell's display name: the earliest-created login in the group is
  // almost always the original client invite (their own name if personal,
  // or Bindly's company name if commercial) — a later-attached employee's
  // own name would be a confusing header for the whole account.
  function shellPrimary(group) {
    return group.slice().sort(function (a, b) { return new Date(a.created) - new Date(b.created); })[0];
  }

  // Every client — solo or multi-login — renders as a collapsed-by-default
  // shell: the client/company name is the main thing shown, and a caret
  // toggle reveals the individual login(s) underneath (see initClientShells).
  function shellHtml(group) {
    var primary = shellPrimary(group);
    var n = group.length;
    var bits = [cap(primary.account_type), n + (n === 1 ? " login" : " logins"), "Bindly " + (primary.bindly_client_id || "—")];
    return '<li class="client-shell">' +
      '<div class="client-shell-head">' +
        '<button class="client-shell-toggle" type="button" aria-expanded="false">' +
          '<span class="doc-ico">' + PERSON_ICON + '</span>' +
          '<span class="doc-meta"><span class="n">' + esc(primary.name || primary.email || "Client") + '</span>' +
          '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
          '<span class="client-shell-caret">' + CARET_ICON + '</span>' +
        '</button>' +
        '<span class="contact-actions">' + addLoginLink(primary) + '</span>' +
      '</div>' +
      '<ul class="client-shell-list" hidden>' + group.map(function (u) { return rowHtml(u, false, primary.name); }).join("") + '</ul>' +
    '</li>';
  }

  // Expand/collapse a client shell (event-delegated so it survives re-renders).
  function initClientShells() {
    var list = $("userList");
    if (!list) return;
    list.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".client-shell-toggle") : null;
      if (!btn) return;
      var shell = btn.closest(".client-shell");
      var body = shell && shell.querySelector(".client-shell-list");
      var open = shell.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (body) body.hidden = !open;
    });
  }

  var clientSearchQuery = "";
  function renderUsers(filter) {
    if (filter !== undefined) clientSearchQuery = filter;
    var el = $("userList");
    if (!el) return;
    var q = clientSearchQuery.trim().toLowerCase();
    var groups = groupUsers(adminState.users);
    if (q) {
      groups = groups.filter(function (g) {
        return g.some(function (u) {
          return (u.name || "").toLowerCase().indexOf(q) > -1 || (u.email || "").toLowerCase().indexOf(q) > -1;
        });
      });
    }
    if (!groups.length) {
      el.innerHTML = '<li class="doc-empty">' +
        (adminState.users.length ? "No clients match “" + esc(clientSearchQuery) + "”." : "No client logins yet.") +
        '</li>';
      return;
    }
    el.innerHTML = groups.map(function (g) { return shellHtml(g); }).join("");
  }

  function initClientSearch() {
    var input = $("clientSearch");
    if (!input) return;
    input.addEventListener("input", function () { renderUsers(input.value); });
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

  // Pre-fills "My contact info" with whatever's already on file (or blank —
  // there may be no row yet). A load failure just leaves the form blank
  // rather than blocking the rest of the admin tab.
  function loadMyProfile() {
    AdminData.getMyProfile().then(function (p) {
      $("mpName").value = p.name || "";
      $("mpPhone").value = p.phone || "";
      $("mpEmail").value = p.email || "";
    }).catch(function () { /* leave the form blank; saving still works */ });
  }

  function initMyProfileForm() {
    var form = $("myProfileForm");
    var modal = $("myProfileModal");
    if (!form || !modal) return;
    var msg = $("myProfileMsg");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "portal-msg";
      msg.textContent = "";
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
      AdminData.updateMyProfile({ phone: $("mpPhone").value.trim(), email: $("mpEmail").value.trim() })
        .then(function () {
          msg.className = "portal-msg ok";
          msg.textContent = "Saved.";
        }).catch(function (err) {
          msg.className = "portal-msg err";
          msg.textContent = (err && err.message) || "Couldn’t save — please try again.";
        }).finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = "Save"; }
        });
    });

    // Single entry point: the header name itself, in staff/admin mode. Shared
    // across every tab, so Staff can reach it too even though they never see
    // the Team tab directly.
    function openModal() {
      msg.className = "portal-msg"; msg.textContent = "";
      loadMyProfile();
      modal.hidden = false;
      var phone = $("mpPhone"); if (phone) phone.focus();
    }
    function closeModal() { modal.hidden = true; }

    var pUserBtn = $("pUser");
    if (pUserBtn) {
      pUserBtn.addEventListener("click", function () {
        // Clients see the same element as a plain name display — only staff/
        // admin mode (showAdmin swaps in the .btn classes) opens the modal.
        if (pUserBtn.classList.contains("btn")) openModal();
      });
    }
    modal.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("[data-close-profile]")) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });
  }

  function initInviteForm() {
    var form = $("inviteForm");
    var modal = $("clientModal");
    if (!form || !modal) return;
    var matchesBox = $("inviteMatches");
    var confirmBox = $("inviteConfirm");
    var nameOverride = ""; // what staff typed in the optional Name field, if anything
    var pending = null;    // { email, name, bindlyClientId, accountType, attach } once a match is chosen
    // attachMode=false: classic "invite the client" (their email must match
    // Bindly). attachMode=true: "add a person to an existing company" — find
    // the company first, then type the new person's own name + email.
    var attachMode = false;

    function applyMode() {
      var emailLbl = $("ivEmailLbl"), emailInput = $("ivEmail");
      var nameField = $("ivNameField");
      var btn = form.querySelector('button[type="submit"]');
      var note = $("inviteFormNote");
      var toggle = $("inviteModeToggle");
      if (attachMode) {
        if (emailLbl) emailLbl.textContent = "Company name or client email";
        if (emailInput) { emailInput.type = "text"; emailInput.placeholder = "e.g. Acosta Drilling"; }
        if (nameField) nameField.hidden = true; // person's name is asked on the confirm step
        if (btn) btn.textContent = "Find company";
        if (note) note.innerHTML = "Give an employee or another person their own login on an existing client&rsquo;s account. Find the company first &mdash; you&rsquo;ll enter the person&rsquo;s name and email on the next step.";
        if (toggle) toggle.textContent = "Back to inviting a client directly";
      } else {
        if (emailLbl) emailLbl.textContent = "Client email";
        if (emailInput) { emailInput.type = "email"; emailInput.placeholder = ""; }
        if (nameField) nameField.hidden = false;
        if (btn) btn.textContent = "Look up client";
        if (note) note.innerHTML = "Create a portal login for a client. They&rsquo;ll get an email to set their own password &mdash; nothing to hand over. Enter their email and we&rsquo;ll look them up in Bindly automatically.";
        if (toggle) toggle.textContent = "Add a person to an existing company";
      }
    }

    function resetToForm() {
      matchesBox.hidden = true; confirmBox.hidden = true; form.hidden = false;
    }

    function openModal() {
      attachMode = false; pending = null; nameOverride = "";
      form.reset();
      resetToForm();
      applyMode();
      var msg = $("inviteMsg"); if (msg) { msg.className = "portal-msg"; msg.textContent = ""; }
      modal.hidden = false;
      var email = $("ivEmail"); if (email) email.focus();
    }
    function closeModal() { modal.hidden = true; }

    // Entry point for the "+ Add login" action on a client row/shell — the
    // company is already known, so this skips the search step entirely and
    // opens straight to "collect the new person's name + email".
    function openAttachFor(clientId, accountType, companyName) {
      if (!clientId) return;
      attachMode = true; nameOverride = "";
      form.reset();
      applyMode();
      var msg = $("inviteMsg"); if (msg) { msg.className = "portal-msg"; msg.textContent = ""; }
      modal.hidden = false;
      chooseMatch("", { client_id: clientId, type: accountType, name: companyName });
    }

    function renderConfirm(p) {
      var html = "";
      if (p.attach) {
        // Attaching a person to a company: show the company, collect the
        // person's own name + email right here.
        html += '<div class="acct-item"><div class="k">Company / client</div><div class="v">' + esc(p.companyName || "—") + '</div></div>';
        html += '<div class="acct-item"><div class="k">Bindly client</div><div class="v">' + esc(p.bindlyClientId || "—") + '</div></div>';
        html += '<div class="acct-item"><div class="k">Person&rsquo;s name</div><div class="v"><input type="text" id="ivPersonName" maxlength="120" placeholder="e.g. Maria Lopez"></div></div>';
        html += '<div class="acct-item"><div class="k">Person&rsquo;s email</div><div class="v"><input type="email" id="ivPersonEmail" maxlength="254" placeholder="their own email"></div></div>';
      } else {
        var rows = [["Email", p.email]];
        if (p.name) rows.push(["Name", p.name]);
        html += rows.map(function (r) {
          return '<div class="acct-item"><div class="k">' + esc(r[0]) + '</div><div class="v">' + esc(r[1] || "—") + '</div></div>';
        }).join("");
      }
      // Account type is auto-detected from Bindly, but Bindly's data has been
      // wrong or missing for real clients (Bobby Jones, Haven Swarts) — so
      // this is an editable dropdown, not a static label, and staff's choice
      // here always wins over whatever Bindly says.
      html += '<div class="acct-item"><div class="k">Account type</div><div class="v">' +
        '<select id="ivConfirmType">' +
        '<option value="personal"' + (p.accountType === "commercial" ? "" : " selected") + '>Personal</option>' +
        '<option value="commercial"' + (p.accountType === "commercial" ? " selected" : "") + '>Commercial</option>' +
        '</select></div></div>';
      if (!p.attach) {
        html += '<div class="acct-item"><div class="k">Bindly client</div><div class="v">' + esc(p.bindlyClientId || "—") + '</div></div>';
      }
      $("inviteConfirmBody").innerHTML = html;
      var title = $("inviteConfirmTitle");
      if (title) title.textContent = p.attach ? "Add a person to this account" : "Confirm this client";
      var warn = $("inviteConfirmWarn");
      if (warn) {
        warn.textContent = p.attach
          ? "This person gets their OWN login (own email + password) that sees this company’s policies, documents, and certificates."
          : "Double-check this is the right client — sending links this login to the Bindly record above.";
      }
      var cmsg = $("inviteConfirmMsg");
      cmsg.className = "portal-msg";
      cmsg.textContent = p.attach ? "" : "Auto-detected from Bindly — change the account type above if it looks wrong.";
    }

    function chooseMatch(email, match) {
      pending = {
        email: attachMode ? "" : email,
        name: attachMode ? "" : (nameOverride || match.name || ""),
        bindlyClientId: match.client_id,
        accountType: match.type === "commercial" ? "commercial" : "personal",
        attach: attachMode,
        companyName: match.name || ""
      };
      renderConfirm(pending);
      matchesBox.hidden = true; form.hidden = true; confirmBox.hidden = false;
      if (attachMode) { var pn = $("ivPersonName"); if (pn) pn.focus(); }
    }

    function renderMatches(email, clients) {
      $("inviteMatchesList").innerHTML = clients.map(function (c, i) {
        var bits = [cap(c.type === "commercial" ? "commercial" : "personal"), "Bindly " + c.client_id].filter(Boolean);
        return '<li><span class="doc-ico">' + PERSON_ICON + '</span>' +
          '<span class="doc-meta"><span class="n">' + esc(c.name || email) + '</span>' +
          '<span class="m">' + esc(bits.join(" · ")) + '</span></span>' +
          '<span class="contact-actions"><a href="#" class="doc-dl" data-pick-match="' + i + '">Select</a></span></li>';
      }).join("");
      var head = $("inviteMatchesTitle");
      if (head) head.textContent = attachMode ? "Select the company" : "Select the right client";
      var note = $("inviteMatchesNote");
      if (note) note.textContent = attachMode
        ? "Pick the client account this person should have access to."
        : "Bindly found more than one match for this email.";
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
      var query = $("ivEmail").value.trim();
      if (attachMode && query.length < 3) {
        msg.className = "portal-msg err";
        msg.textContent = "Enter at least a few characters of the company name (or their email).";
        return;
      }
      nameOverride = $("ivName").value.trim();
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      msg.textContent = attachMode ? "Searching Bindly…" : "Looking up this client in Bindly…";
      AdminData.lookupClient(query).then(function (res) {
        var clients = (res && res.clients) || [];
        if (clients.length === 0) {
          msg.className = "portal-msg err";
          msg.textContent = attachMode
            ? "No Bindly client found for that search. Try the company name as it appears in Bindly."
            : "No Bindly client found for that email. Double-check it, or confirm which email is on file with the client.";
        } else if (clients.length === 1 && !attachMode) {
          msg.textContent = "";
          chooseMatch(query, clients[0]);
        } else {
          // In attach mode always show the picker, even for a single match —
          // staff should consciously confirm WHICH account they're opening up.
          msg.textContent = "";
          renderMatches(query, clients);
        }
      }).catch(function (err) {
        msg.className = "portal-msg err";
        msg.textContent = err && err.message ? err.message : "Couldn’t look up this client — try again.";
      }).finally(function () { btn.disabled = false; });
    });

    var modeToggle = $("inviteModeToggle");
    if (modeToggle) {
      modeToggle.addEventListener("click", function (e) {
        e.preventDefault();
        attachMode = !attachMode;
        form.reset();
        var msg = $("inviteMsg"); msg.className = "portal-msg"; msg.textContent = "";
        resetToForm();
        applyMode();
        $("ivEmail").focus();
      });
      applyMode();
    }

    $("inviteMatchesBackBtn").addEventListener("click", resetToForm);
    $("inviteBackBtn").addEventListener("click", resetToForm);

    // "+ Add login" on a client row/shell (rendered in renderUsers/shellHtml).
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("[data-add-login]") : null;
      if (!a) return;
      e.preventDefault();
      openAttachFor(a.getAttribute("data-add-login"), a.getAttribute("data-add-login-type"), a.getAttribute("data-add-login-name"));
    });

    var addBtn = $("clientAddBtn");
    if (addBtn) addBtn.addEventListener("click", openModal);
    // Close on the X, Cancel, or the dark backdrop.
    modal.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("[data-close-client]")) closeModal();
    });
    // Close on Escape.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });

    $("inviteSendBtn").addEventListener("click", function () {
      if (!pending) return;
      var typeSel = $("ivConfirmType");
      if (typeSel) pending.accountType = typeSel.value === "commercial" ? "commercial" : "personal";
      var cmsg = $("inviteConfirmMsg");
      if (pending.attach) {
        // The person's own details are collected on this confirm step.
        var pEmail = ($("ivPersonEmail") ? $("ivPersonEmail").value : "").trim();
        var pName = ($("ivPersonName") ? $("ivPersonName").value : "").trim();
        if (!/^\S+@\S+\.\S+$/.test(pEmail)) {
          cmsg.className = "portal-msg err";
          cmsg.textContent = "Enter the person’s email address.";
          var pe = $("ivPersonEmail"); if (pe) pe.focus();
          return;
        }
        pending.email = pEmail;
        pending.name = pName;
      }
      cmsg.className = "portal-msg"; cmsg.textContent = "Sending…";
      var btn = $("inviteSendBtn"); btn.disabled = true;
      AdminData.invite(pending).then(function (res) {
        if (res && res.ok) {
          var sentEmail = pending.email;
          pending = null;
          closeModal();
          showToast("Invite sent to " + sentEmail + ". They’ll get an email to set their password.");
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
    var clientTabs = ["overview", "documents", "certificates", "service", "account"];
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
    var pUserAdmin = $("pUser");
    if (pUserAdmin) {
      pUserAdmin.textContent = (user && user.name) || "IPG Admin";
      // In staff/admin mode this doubles as the "My contact info" trigger —
      // look like a real button, matching Sign out next to it.
      pUserAdmin.classList.remove("plain-btn");
      pUserAdmin.classList.add("btn", "btn-outline", "btn-sm");
    }
    $("pWelcome").textContent = "Admin";
    $("pCompany").textContent = adminIsAdmin
      ? "Create and manage client logins and team members."
      : "Create and manage client logins.";
    activateTab("admin");
    loadUsers();
    loadMyProfile();
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
    var pUserClient = $("pUser");
    if (pUserClient) {
      pUserClient.textContent = (client && (client.company || client.name)) || "Client";
      // Clients never get the "My contact info" trigger — reset back to a
      // plain name display in case this browser was just an admin/staff login.
      pUserClient.classList.remove("btn", "btn-outline", "btn-sm");
      pUserClient.classList.add("plain-btn");
    }
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
      // to sign the client in. Checking Clerk.client too matters: on a slow
      // connection window.Clerk can exist before load() has run, and calling
      // into it then would throw before the button could re-enable.
      if (!(CLERK_ENABLED && window.Clerk && window.Clerk.client)) {
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
      // Real auth: Clerk ends the session; its listener re-renders the login
      // in place. Without an explicit redirectUrl, Clerk falls back to the
      // instance's configured Home URL (the main site root) instead of
      // staying on /portal/ — so pin it here.
      if (CLERK_ENABLED && window.Clerk) {
        window.Clerk.signOut({ redirectUrl: "/portal/" });
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
      else if (++tries > 120) { // ~6s: show the fallback, but KEEP waiting —
        clearInterval(t);      // on slow mobile connections Clerk often lands
        if (onTimeout) onTimeout(); // a few seconds late, and sign-in should
        var slowTries = 0;     // recover on its own instead of staying dead.
        var t2 = setInterval(function () {
          if (window.Clerk) { clearInterval(t2); cb(); }
          else if (++slowTries > 110) clearInterval(t2); // give up after ~1 more min
        }, 500);
      }
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
        //
        // Clerk fires this listener on ANY resource change — background session
        // refreshes included, not just sign-in/out. Re-rendering on every event
        // used to yank clients back to the Overview tab mid-form, so only
        // re-render when who's signed in actually changes.
        function authKey() {
          var C = window.Clerk;
          return (C.user ? C.user.id : "out") + ":" + (C.session ? C.session.id : "none");
        }
        var lastAuthKey = null;
        function renderIfAuthChanged() {
          if (inAcceptFlow) return;
          var key = authKey();
          if (key === lastAuthKey) return;
          lastAuthKey = key;
          renderAuthState();
        }
        window.Clerk.addListener(renderIfAuthChanged);
        if (ticket) { startAcceptFlow(ticket); return; }
        renderIfAuthChanged();
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
      // Clerk itself never collects a name through the invite/accept flow, so
      // fullName/firstName are only ever set if the person edits their own
      // Clerk profile later. The name staff typed at invite time (e.g. the
      // "Person's name" field when adding an employee to an existing
      // company) is what's actually on file for who this login is — it
      // lives in publicMetadata.name (see metaFor/teamMeta in
      // portal-admin-users.js) and should count as a real name too.
      var realName = Clerk.user.fullName || Clerk.user.firstName || md.name || "";
      var name = realName || email || "Client";
      // Staff/admin go to the admin tab (they have no client dashboard).
      var role = (md.role === "staff" || md.role === "admin") ? md.role : "client";
      if (role !== "client") { showAdmin({ name: name, role: role, id: Clerk.user.id }); return; }
      var type = md.account_type === "commercial" ? "commercial" : "personal";
      PortalData._type = type;
      // The logged-in person's own Clerk name/email — used as the greeting
      // for commercial accounts (whose Bindly "name" is the business contact,
      // not necessarily the person signed in) and as a fallback until the
      // real Bindly profile loads. clerkHasRealName distinguishes an actual
      // Clerk-set name from the raw-email fallback, so updateHeaderName can
      // prefer Bindly's contact name over showing someone's email address.
      state.clerkName = name;
      state.clerkHasRealName = !!realName;
      showDashboard({ name: name, company: md.company || "", type: type });
    } else {
      // Signed out — show the native login form (reset any code step), and
      // drop the previous user's data so nothing lingers on a shared machine.
      clearClientState();
      appView.hidden = true;
      loginView.hidden = false;
      siteHeader(true);
      if (loginForm) loginForm.hidden = false;
      if (twoFactorForm) twoFactorForm.hidden = true;
      var resetFormEl = $("resetForm");
      if (resetFormEl) resetFormEl.hidden = true;
      // Restore the normal sub-copy (it may still say "temporarily
      // unavailable" if Clerk loaded late and sign-in just recovered).
      var sub = $("loginSub");
      if (sub) {
        sub.textContent = STAFF_ENTRY
          ? "Sign in to manage client portal accounts."
          : "Access your policies, documents, and certificates of insurance.";
      }
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
    // "Resend code" only makes sense for the emailed code (an authenticator
    // app generates its own).
    var resend = $("tfResend"); if (resend) resend.hidden = strategy !== "email_code";
    var code = $("tfCode"); if (code) { code.value = ""; code.focus(); }
  }

  function backToLogin() {
    if (twoFactorForm) twoFactorForm.hidden = true;
    var resetForm = $("resetForm"); if (resetForm) resetForm.hidden = true;
    if (loginForm) loginForm.hidden = false;
    var sub = $("loginSub");
    if (sub) {
      sub.textContent = STAFF_ENTRY
        ? "Sign in to manage client portal accounts."
        : "Access your policies, documents, and certificates of insurance.";
    }
    loginMsg.className = "portal-msg"; loginMsg.textContent = "";
  }

  // Pull Clerk's human-readable explanation out of an API error, with a fallback.
  function clerkDetail(err, fallback) {
    var e0 = err && err.errors && err.errors[0];
    return (e0 && (e0.longMessage || e0.long_message || e0.message)) || fallback;
  }

  // ---- Extra code-step actions (resend / back) ----
  function init2faExtras() {
    var resend = $("tfResend"), back = $("tfBack");
    if (resend) {
      resend.addEventListener("click", function (e) {
        e.preventDefault();
        if (!(window.Clerk && window.Clerk.client && _tfStrategy === "email_code")) return;
        var tfMsg = $("tfMsg");
        window.Clerk.client.signIn.prepareSecondFactor({ strategy: "email_code" })
          .then(function () { tfMsg.className = "portal-msg ok"; tfMsg.textContent = "A new code is on its way — check your email."; })
          .catch(function () { tfMsg.className = "portal-msg err"; tfMsg.textContent = "Couldn’t send a new code — go back and sign in again."; });
      });
    }
    if (back) back.addEventListener("click", function (e) { e.preventDefault(); backToLogin(); });
  }

  // ---- Forgot password (self-service reset via emailed code) ----
  function initForgotPassword() {
    var link = $("forgotPw");
    var resetForm = $("resetForm");
    if (!link || !resetForm) return;
    var rpMsg = $("rpMsg");

    function sendResetCode(email) {
      return window.Clerk.client.signIn.create({
        strategy: "reset_password_email_code",
        identifier: email
      });
    }

    link.addEventListener("click", function (e) {
      e.preventDefault();
      loginMsg.className = "portal-msg"; loginMsg.textContent = "";
      var email = $("plEmail").value.trim();
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        loginMsg.className = "portal-msg err";
        loginMsg.textContent = "Enter your email above first, then click “Forgot password?” again.";
        $("plEmail").focus();
        return;
      }
      if (!(CLERK_ENABLED && window.Clerk && window.Clerk.client)) {
        loginMsg.className = "portal-msg err";
        loginMsg.textContent = "Sign-in is temporarily unavailable. Please try again shortly.";
        return;
      }
      loginMsg.textContent = "Sending you a reset code…";
      sendResetCode(email).then(function () {
        loginForm.hidden = true;
        resetForm.hidden = false;
        var sub = $("loginSub");
        if (sub) sub.textContent = "We emailed a 6-digit code to " + email + ". Enter it below with your new password.";
        rpMsg.className = "portal-msg"; rpMsg.textContent = "";
        $("rpCode").value = ""; $("rpCode").focus();
        loginMsg.textContent = "";
      }).catch(function (err) {
        loginMsg.className = "portal-msg err";
        // Don't reveal whether the email exists — keep the generic wording
        // unless Clerk says something safe and useful (e.g. rate limited).
        loginMsg.textContent = "We couldn’t start a reset for that email. Double-check it, or call us at (214) 377-1460.";
        void err;
      });
    });

    var rpResend = $("rpResend");
    if (rpResend) {
      rpResend.addEventListener("click", function (e) {
        e.preventDefault();
        var email = $("plEmail").value.trim();
        if (!email) { backToLogin(); return; }
        sendResetCode(email)
          .then(function () { rpMsg.className = "portal-msg ok"; rpMsg.textContent = "A new code is on its way — check your email."; })
          .catch(function () { rpMsg.className = "portal-msg err"; rpMsg.textContent = "Couldn’t send a new code — try again in a minute."; });
      });
    }
    var rpBack = $("rpBack");
    if (rpBack) rpBack.addEventListener("click", function (e) { e.preventDefault(); backToLogin(); });

    resetForm.addEventListener("submit", function (e) {
      e.preventDefault();
      rpMsg.className = "portal-msg"; rpMsg.textContent = "";
      if (!resetForm.checkValidity()) { resetForm.reportValidity(); return; }
      var p1 = $("rpPass").value, p2 = $("rpPass2").value;
      if (p1 !== p2) { rpMsg.className = "portal-msg err"; rpMsg.textContent = "The two passwords don’t match."; return; }
      var btn = resetForm.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Resetting…"; }
      window.Clerk.client.signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code: $("rpCode").value.trim()
      }).then(function (res) {
        if (res.status === "needs_new_password") {
          return window.Clerk.client.signIn.resetPassword({ password: p1, signOutOfOtherSessions: true });
        }
        return res;
      }).then(function (res) {
        if (res.status === "complete") {
          // Signed in with the new password — the Clerk listener reveals the
          // dashboard from here.
          return window.Clerk.setActive({ session: res.createdSessionId });
        }
        throw new Error("incomplete");
      }).catch(function (err) {
        rpMsg.className = "portal-msg err";
        rpMsg.textContent = clerkDetail(err, "That code wasn’t right, or the password wasn’t accepted. Please try again.");
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Reset password & sign in"; }
      });
    });
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
  initPolicyCards();
  initDocSearch();
  initHolderForm();
  initServiceForm();
  initContactForm();
  initInviteForm();
  initMyProfileForm();
  initTeamInviteForm();
  initUserActions();
  initClientSearch();
  initClientShells();
  initPlaceholderDownloads();
  initFreshDownloads();
  initDocPreview();
  init2faExtras();
  initForgotPassword();
  initAuth();

  // Local-dev hook (localhost only) for exercising the invite-accept UI and
  // poking the live data layers from the console. Not defined on the live domain.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    // Localhost-only visual harness: render the dashboard with representative
    // data so the UI can be reviewed without a live Clerk login + Bindly
    // backend. Inert on ipg.team (this whole block never runs off localhost).
    function renderSample(type) {
      var commercial = type !== "personal";
      state.commercial = commercial;
      state.policies = [
        { type: "General Liability", number: "CBE00432048P-00", carrier: "QuoteWell (MGA)",
          term: "May 2025 – May 2026", effective: "May 2025", expiration: "May 2026",
          status: "active", renewsSoon: true, daysToRenew: 9,
          coverages: [ { label: "Each Occurrence", value: "$1,000,000" }, { label: "General Aggregate", value: "$2,000,000" },
            { label: "Products / Completed Ops", value: "$2,000,000" }, { label: "Damage to Rented Premises", value: "$100,000" },
            { label: "Medical Expense", value: "$5,000" }, { label: "Deductible", value: "$2,500" } ] },
        { type: "Workers Compensation", number: "TXM-99812", carrier: "Texas Mutual",
          term: "Jan 2026 – Jan 2027", effective: "Jan 2026", expiration: "Jan 2027",
          status: "active", renewsSoon: false, daysToRenew: 180,
          coverages: [ { label: "E.L. Each Accident", value: "$1,000,000" }, { label: "E.L. Disease — Policy Limit", value: "$1,000,000" } ] },
        { type: "Commercial Auto", number: "CA-55231", carrier: "Progressive",
          term: "Mar 2024 – Mar 2025", effective: "Mar 2024", expiration: "Mar 2025",
          status: "expired", renewsSoon: false, daysToRenew: -120, coverages: [] }
      ];
      state.documents = [
        { name: "Acosta Drilling_GL Binder.pdf", kind: "Policies", date: "May 30, 2025", year: 2025, url: "#" },
        { name: "Workers Comp Policy 2026.pdf", kind: "Policies", date: "Jan 2, 2026", year: 2026, url: "#" },
        { name: "Auto ID Card.pdf", kind: "ID Cards", date: "Mar 3, 2024", year: 2024, url: "#" },
        { name: "GL Dec Page.pdf", kind: "Declarations", date: "May 30, 2025", year: 2025, url: "#" },
        { name: "2025 Loss Runs.pdf", kind: "Loss Runs", date: "Jun 1, 2026", year: 2026, url: "#" }
      ];
      // Master COI is its own source of truth (Bindly's master_coi approval
      // record), not part of the documents listing — see renderMasterCoi().
      state.masterCoi = commercial
        ? { approved: true, stale: false, approvedBy: "Cole LeClair", approvedAt: "2026-06-15", url: "#" }
        : null;
      state.holders = commercial ? [
        { id: "c1", name: "City of Dallas", address: "1500 Marilla St, Dallas, TX 75201", status: "issued", date: "Jul 1, 2026", url: "#" }
      ] : [];
      state.contacts = [ { id: "p1", name: "Jane Doe", role: "Billing", email: "jane@example.com", phone: "214-555-0148" } ];
      loginView.hidden = true; appView.hidden = false; siteHeader(false);
      setChrome("client");
      var certTab = $("certTab"); if (certTab) certTab.hidden = !commercial;
      // Mirrors the REAL flow: commercial headers show the business, but the
      // big greeting names the actual person signed in (see updateHeaderName).
      state.clerkName = commercial ? "Maria Lopez" : "Jared Viracola";
      $("pUser").textContent = commercial ? "Acosta Drilling Inc" : "Jared Viracola";
      $("pWelcome").textContent = "Welcome, " + (commercial ? "Maria Lopez" : "Jared") + ".";
      $("pCompany").textContent = commercial ? "Acosta Drilling Inc" : "";
      renderQuickActions();
      renderPolicies();
      var search = $("docSearch"); if (search) search.value = "";
      renderDocGroups("");
      renderHolders();
      renderMasterCoi();
      renderAccount({ name: commercial ? "Acosta Drilling Inc" : "Jared Viracola",
        company: commercial ? "Acosta Drilling Inc" : "", email: "client@example.com", phone: "214-555-0100",
        address: "123 Main St, Dallas, TX 75201",
        producer: { name: "Cole LeClair", phone: "214-404-9776", email: "cole@ipg.team" },
        csrs: [
          { name: "Julie Nguyen", phone: "469-679-1951", email: "julie@ipg.team" },
          { name: "Ashton Warman", phone: "214-308-0985", email: "ashton@ipg.team" }
        ] });
      renderContacts();
      updateStats();
      $("statDocs").textContent = state.documents.length;
      activateTab("overview");
    }
    window.__portalDebug = { data: PortalData, reload: loadDashboard, admin: AdminData,
      renderSample: renderSample,
      showAccept: function () { showAcceptView(); var f = $("acEmail"); if (f) f.value = "teammate@ipg.team"; } };
  }
})();
