// =====================================================================
// STAFF/ADMIN TAB API — create & manage client portal logins.
// Maps to AdminData.listUsers()/invite()/resend()/revoke() in portal.js.
// =====================================================================
//
//   GET  /portal-admin-users            -> list client logins (invited + active)
//   POST /portal-admin-users {action:'lookup', email} -> find Bindly client(s) matching an email
//   POST /portal-admin-users            -> invite a client   { email, bindlyClientId, name? }
//   POST /portal-admin-users {action:'resend', id, email, bindlyClientId, name?}
//   POST /portal-admin-users {action:'revoke', id}
//
// STAFF-ONLY. Every path goes through auth.verifyStaff (role ∈ staff|admin),
// enforced server-side off the verified Clerk token — never trust the browser.
//
// SOURCE OF TRUTH = CLERK. "Invited" rows are pending Clerk invitations;
// "active" rows are Clerk users who accepted. This works before Neon is wired.
// TODO(DB): once the portal DB exists, ALSO mirror invites/users into
// portal_users + invitations (ARCHITECTURE.md §3) for richer columns and to
// join Bindly data — but keep Clerk as the identity source of truth.
//
// BINDLY AUTO-DETECT (2026-07-11): staff no longer type a Bindly client id or
// account type. `action:'lookup'` calls bindly.lookupClient(email) so the
// browser can show the matching Bindly record(s) to confirm. The invite/resend
// POST still only accepts a `bindlyClientId` as a SELECTION — verifyBindlyClient()
// below re-runs the Bindly lookup server-side and rejects the request unless
// that id is actually one of the matches for the given email, so the browser
// can never just make up a client id or account type.
var auth = require("./utils/auth");
var clerk = require("./utils/clerk");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toArray(x) {
  if (Array.isArray(x)) return x;             // Clerk sometimes returns a bare array
  if (x && Array.isArray(x.data)) return x.data; // ...or { data:[...], total_count }
  return [];
}

// A pending Clerk invitation -> the row the admin tab renders.
function inviteToRow(inv) {
  var md = inv.public_metadata || {};
  return {
    id: inv.id,
    email: inv.email_address || "",
    name: md.name || "",
    bindly_client_id: md.bindly_client_id || "",
    account_type: md.account_type || "",
    role: md.role || "client",
    status: inv.status === "pending" ? "invited" : inv.status, // pending -> "invited"
    created: inv.created_at || null                            // unix ms
  };
}

// An accepted Clerk user -> the row the admin tab renders.
function userToRow(u) {
  var md = u.public_metadata || {};
  var email = (u.email_addresses && u.email_addresses[0] && u.email_addresses[0].email_address) || "";
  // Prefer the client's Clerk first/last name; fall back to the Bindly-detected
  // name we stored in metadata at invite time, so accounts where the client only
  // set a password (no name typed) still show a real name instead of their email.
  var name = [u.first_name, u.last_name].filter(Boolean).join(" ") || md.name || "";
  return {
    id: u.id,
    email: email,
    name: name,
    bindly_client_id: md.bindly_client_id || "",
    account_type: md.account_type || "",
    role: md.role || "client",
    status: "active",
    created: u.created_at || null
  };
}

function byNewest(a, b) { return (b.created || 0) - (a.created || 0); }
function isTeamRole(r) { return r === "staff" || r === "admin"; }

async function listRows() {
  // Pending invitations + accepted users, merged, then split into two groups:
  // clients (role 'client') and team members (role 'staff'|'admin').
  var results = await Promise.all([
    clerk.listInvitations("pending").catch(function () { return []; }),
    clerk.listUsers().catch(function () { return []; })
  ]);
  var all = toArray(results[0]).map(inviteToRow).concat(toArray(results[1]).map(userToRow));
  var clients = all.filter(function (r) { return !isTeamRole(r.role); });
  var team = all.filter(function (r) { return isTeamRole(r.role); });
  clients.sort(byNewest);
  team.sort(byNewest);
  return { clients: clients, team: team };
}

function cleanInvite(input) {
  var email = String(input.email == null ? "" : input.email).trim();
  var client = String(input.bindlyClientId == null ? "" : input.bindlyClientId).trim();
  var name = String(input.name == null ? "" : input.name).trim().slice(0, 120);
  // Staff's account-type SELECTION on the confirm screen — optional. When
  // present it overrides whatever Bindly's data says (see verifyBindlyClient
  // below): Bindly's `type` field has repeatedly come back wrong or empty for
  // real clients (Bobby Jones, Haven Swarts — both confirmed directly against
  // Bindly's API), so staff get the final say rather than a field we can't
  // trust. This is safe to trust from the browser here ONLY because this
  // whole endpoint is staff-only (auth.verifyStaff) — it is never client input.
  var accountType = String(input.accountType == null ? "" : input.accountType).trim();
  if (!EMAIL_RE.test(email)) return { error: "a valid client email is required" };
  if (!client) return { error: "no Bindly client selected — look up the client by email first" };
  if (accountType && accountType !== "personal" && accountType !== "commercial") {
    return { error: "account type must be personal or commercial" };
  }
  return { data: { email: email, client: client, name: name, accountType: accountType } };
}

// Confirms clientId is actually a Bindly match for this EMAIL (so the browser
// can't invent an unrelated client id — this part is still a hard check, not
// a suggestion), and returns Bindly's best guess at account type + name as a
// FALLBACK for when staff didn't override it. Returns { type, bindlyName } or
// { error }.
//
// IMPORTANT: Bindly's `type` field is not reliable. Their search endpoint
// (GET /clients?q=) doesn't return it at all (empty string in their own API
// doc's example), and even the full profile (GET /clients/{id}) has returned
// wrong or empty values for real clients — see the July 11 "Bobby Jones" /
// "Haven Swarts" incidents and questions 11/12 in
// "Bindly Read-API Questions (for Bindly dev).md". Treat this as a fallback
// default only; the invite handler lets staff override it (see cleanInvite).
async function verifyBindlyClient(email, clientId) {
  if (!bindly.configured()) return { error: "Bindly portal API isn't configured yet" };
  var found;
  try { found = await bindly.lookupClient(email); }
  catch (e) { return { error: "couldn't verify this client with Bindly: " + e.message }; }
  var list = (found && found.clients) || [];
  var match = list.filter(function (c) { return String(c.client_id) === clientId; })[0];
  if (!match) return { error: "that client no longer matches a Bindly record for this email — look it up again" };
  var profile;
  try { profile = await bindly.getClient(clientId); }
  catch (e2) { return { error: "couldn't verify this client's account type with Bindly: " + e2.message }; }
  return {
    type: (profile && profile.type === "commercial") ? "commercial" : "personal",
    bindlyName: (profile && profile.name) || match.name || ""
  };
}

function metaFor(v) {
  var md = { bindly_client_id: v.client, account_type: v.type, role: "client" };
  if (v.name) md.name = v.name;
  return md;
}

// Metadata for a team-member (staff/admin) invite — no Bindly link/type.
function teamMeta(role, name) {
  var md = { role: role };
  var n = String(name == null ? "" : name).trim().slice(0, 120);
  if (n) md.name = n;
  return md;
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== "GET" && method !== "POST") {
    return respond.json(405, { error: "method not allowed" });
  }

  var staff;
  try { staff = await auth.verifyStaff(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  // Per-staff limit. POSTs (invite/resend/lookup/delete) each hit Clerk and/or
  // Bindly, so they're capped tighter than the GET list refresh.
  var limited = ratelimit.guard({
    scope: "portal-admin-users",
    limit: method === "POST" ? 30 : 60,
    event: event, ctx: staff
  });
  if (limited) return limited;

  var redirectUrl = process.env.PORTAL_INVITE_REDIRECT_URL || "";

  try {
    if (method === "GET") {
      var lists = await listRows();
      // Team members are only exposed to admins.
      return respond.json(200, { users: lists.clients, team: staff.role === "admin" ? lists.team : [] });
    }

    // ---- POST ----
    var body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e2) { return respond.json(400, { error: "invalid json" }); }

    var action = body.action;
    // A team invite (staff/admin) requires ADMIN. Clients can be added by any staff.
    var reqRole = String(body.role || "client").trim();
    var team = isTeamRole(reqRole);
    if (team && staff.role !== "admin") {
      return respond.json(403, { error: "only admins can add or manage team members" });
    }

    if (action === "lookup") {
      var lkEmail = String(body.email == null ? "" : body.email).trim();
      if (!EMAIL_RE.test(lkEmail)) return respond.json(400, { error: "a valid email is required" });
      if (!bindly.configured()) return respond.json(501, { error: "Bindly portal API isn't configured yet" });
      var lkFound;
      try { lkFound = await bindly.lookupClient(lkEmail); }
      catch (e0) { return respond.json(e0.status || 502, { error: e0.message }); }
      return respond.json(200, { clients: (lkFound && lkFound.clients) || [] });
    }

    if (action === "revoke") {
      if (!body.id) return respond.json(400, { error: "id is required" });
      await clerk.revokeInvitation(body.id);
      audit.log({ action: "invite_revoked", actor: staff.authUserId, target: body.id });
      return respond.json(200, { ok: true });
    }

    if (action === "delete") {
      // Permanently remove an ACTIVE login (a Clerk user). Irreversible.
      if (!body.id) return respond.json(400, { error: "id is required" });
      if (body.id === staff.authUserId) return respond.json(400, { error: "you can't remove your own login" });
      // Non-admins may remove clients only, never staff/admins. If the role
      // lookup fails we REFUSE the delete (fail closed) — a transient Clerk
      // error must never let staff delete a team member.
      if (staff.role !== "admin") {
        var t;
        try { t = await clerk.getUser(body.id); }
        catch (e3) { return respond.json(502, { error: "couldn't verify that login just now — try again" }); }
        var trole = (t && t.public_metadata && t.public_metadata.role) || "client";
        if (isTeamRole(trole)) return respond.json(403, { error: "only admins can remove team members" });
      }
      await clerk.deleteUser(body.id);
      audit.log({ action: "user_deleted", actor: staff.authUserId, target: body.id });
      return respond.json(200, { ok: true });
    }

    if (action === "resend") {
      // Clerk has no "resend" — revoke the old invite, then create a fresh one
      // (which sends a new email). Needs the invite's details from the caller.
      if (team) {
        var teEmail = String(body.email || "").trim();
        if (!EMAIL_RE.test(teEmail)) return respond.json(400, { error: "a valid email is required" });
        if (body.id) { try { await clerk.revokeInvitation(body.id); } catch (ignore1) { /* already gone */ } }
        var reTeam = await clerk.createInvitation(teEmail, teamMeta(reqRole, body.name), redirectUrl);
        audit.log({ action: "team_invite_resent", actor: staff.authUserId, target: reTeam && reTeam.id });
        return respond.json(200, { ok: true, user: inviteToRow(reTeam) });
      }
      var checkedR = cleanInvite(body);
      if (checkedR.error) return respond.json(400, { error: checkedR.error });
      var verifiedR = await verifyBindlyClient(checkedR.data.email, checkedR.data.client);
      if (verifiedR.error) return respond.json(400, { error: verifiedR.error });
      checkedR.data.type = checkedR.data.accountType || verifiedR.type;
      if (!checkedR.data.name) checkedR.data.name = verifiedR.bindlyName;
      if (body.id) { try { await clerk.revokeInvitation(body.id); } catch (ignore) { /* already gone */ } }
      var reInv = await clerk.createInvitation(checkedR.data.email, metaFor(checkedR.data), redirectUrl);
      audit.log({ action: "invite_resent", actor: staff.authUserId, target: reInv && reInv.id, bindlyClientId: checkedR.data.client });
      return respond.json(200, { ok: true, user: inviteToRow(reInv) });
    }

    // Default POST = create a new invite (client OR team member).
    if (team) {
      var tmEmail = String(body.email || "").trim();
      if (!EMAIL_RE.test(tmEmail)) return respond.json(400, { error: "a valid email is required" });
      var tmInv = await clerk.createInvitation(tmEmail, teamMeta(reqRole, body.name), redirectUrl);
      audit.log({ action: "team_invited", actor: staff.authUserId, target: tmInv && tmInv.id });
      return respond.json(201, { ok: true, user: inviteToRow(tmInv) });
    }
    var checked = cleanInvite(body);
    if (checked.error) return respond.json(400, { error: checked.error });
    var verified = await verifyBindlyClient(checked.data.email, checked.data.client);
    if (verified.error) return respond.json(400, { error: verified.error });
    checked.data.type = checked.data.accountType || verified.type;
    if (!checked.data.name) checked.data.name = verified.bindlyName;
    var inv = await clerk.createInvitation(checked.data.email, metaFor(checked.data), redirectUrl);
    audit.log({ action: "invite_created", actor: staff.authUserId, target: inv && inv.id, bindlyClientId: checked.data.client });
    return respond.json(201, { ok: true, user: inviteToRow(inv) });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
