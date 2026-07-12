// =====================================================================
// CLERK BACKEND — the ONLY module that calls Clerk's server-side API.
// Holds the SECRET key (sk_...) so it never reaches the browser.
// =====================================================================
//
// Used by the staff/admin tab (portal-admin-users.js) to:
//   * invite a client   -> POST /invitations   (Clerk emails a setup link)
//   * list who's invited -> GET  /invitations   (status 'pending')
//   * list who's active  -> GET  /users         (accepted invites become users)
//   * revoke an invite   -> POST /invitations/:id/revoke
//
// WHY CLERK (not our DB) is the source of truth here: Clerk already tracks
// "invited vs. accepted" natively. Reading from Clerk means the admin tab works
// the moment CLERK_SECRET_KEY is set — before Neon is even connected. Once the
// portal DB is wired we can ALSO mirror these into portal_users for richer
// columns/audit (see ARCHITECTURE.md §3), but Clerk stays the identity truth.
//
// SECRET: needs CLERK_SECRET_KEY (sk_...). Set it in Netlify env vars (prod)
// and IPG Website/.env (local). It is NOT the same as the public JWKS/publishable
// key used to VERIFY logins — this one CREATES and manages users, so guard it.

var SECRET = (process.env.CLERK_SECRET_KEY || "").trim();
var BASE = "https://api.clerk.com/v1";

function configured() {
  return Boolean(SECRET);
}

async function call(method, path, body) {
  if (!configured()) {
    var e = new Error("Clerk backend not configured — set CLERK_SECRET_KEY");
    e.status = 501;
    throw e;
  }
  var res = await fetch(BASE + path, {
    method: method,
    headers: {
      "Authorization": "Bearer " + SECRET,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  var data;
  try { data = await res.json(); } catch (e) { data = null; }

  if (!res.ok) {
    // Surface Clerk's human-readable reason (e.g. "already invited") when present.
    var msg = (data && data.errors && data.errors.length)
      ? data.errors.map(function (er) { return er.long_message || er.message; }).join("; ")
      : ("Clerk request failed (HTTP " + res.status + ")");
    var err = new Error(msg);
    err.status = res.status === 400 || res.status === 422 ? 400 : 502;
    throw err;
  }
  return data;
}

// Clerk's list endpoints cap at 100 rows per page (regardless of the limit
// requested) and return either a bare array or { data, total_count } — page
// through with offset until a page comes back short, so the admin tab always
// sees every client/invite instead of silently stopping at the first 100.
// PAGE_CAP is just a runaway-loop backstop for a misbehaving response; real
// client counts are nowhere near it today.
var PAGE_CAP = 50; // 50 * 100 = 5,000 rows, far beyond any near-term client count

async function listAll(path, query) {
  var out = [];
  var offset = 0;
  for (var page = 0; page < PAGE_CAP; page++) {
    var res = await call("GET", path + query + "&limit=100&offset=" + offset);
    var items = Array.isArray(res) ? res : ((res && Array.isArray(res.data)) ? res.data : []);
    out = out.concat(items);
    if (items.length < 100) return out; // short page = last page
    offset += 100;
  }
  console.log("CLERK_LIST_PAGE_CAP_HIT " + path + " — stopped after " + (PAGE_CAP * 100) + " rows");
  return out;
}

module.exports = {
  configured: configured,

  // Invite a client. publicMetadata (bindly_client_id, account_type, role) is
  // copied onto the user when they accept, so the login already carries the
  // Bindly link + type — no second step. `notify:true` makes Clerk send the
  // setup email; `redirectUrl` (optional) is where they land after setting a
  // password.
  createInvitation: function (email, publicMetadata, redirectUrl) {
    var payload = { email_address: email, public_metadata: publicMetadata, notify: true };
    if (redirectUrl) payload.redirect_url = redirectUrl;
    return call("POST", "/invitations", payload);
  },

  // Pending invites = clients who've been emailed but haven't set up yet.
  // Returns a plain array of every matching invitation (all pages).
  listInvitations: function (status) {
    var q = "?order_by=-created_at" + (status ? "&status=" + encodeURIComponent(status) : "");
    return listAll("/invitations", q);
  },

  revokeInvitation: function (id) {
    return call("POST", "/invitations/" + encodeURIComponent(id) + "/revoke");
  },

  // Accepted invites = active logins. Returns a plain array of every user (all pages).
  listUsers: function () {
    return listAll("/users", "?order_by=-created_at");
  },

  getUser: function (id) {
    return call("GET", "/users/" + encodeURIComponent(id));
  },

  // Permanently delete an active login (the client can no longer sign in).
  deleteUser: function (id) {
    return call("DELETE", "/users/" + encodeURIComponent(id));
  }
};
