// =====================================================================
// STAFF/ADMIN TAB API — create & manage client portal logins.
// Maps to AdminData.listUsers()/invite()/resend()/revoke() in portal.js.
// =====================================================================
//
//   GET  /portal-admin-users            -> list client logins (invited + active)
//   POST /portal-admin-users            -> invite a client   { email, bindlyClientId, accountType, name? }
//   POST /portal-admin-users {action:'resend', id, email, bindlyClientId, accountType, name?}
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
// TODO(Bindly): auto-detect the client from the email. When Bindly's
// "look up client by email" lands (ARCHITECTURE.md §9 q2), the invite POST can
// resolve bindlyClientId + accountType server-side from `email` instead of
// trusting what the browser sends — and reject if no Bindly client matches.
var auth = require("./utils/auth");
var clerk = require("./utils/clerk");
var respond = require("./utils/respond");
var audit = require("./utils/audit");

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
  var name = [u.first_name, u.last_name].filter(Boolean).join(" ");
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
  var type = String(input.accountType == null ? "" : input.accountType).trim();
  var name = String(input.name == null ? "" : input.name).trim().slice(0, 120);
  if (!EMAIL_RE.test(email)) return { error: "a valid client email is required" };
  if (!client) return { error: "the Bindly client id is required" };
  if (type !== "personal" && type !== "commercial") return { error: "account type must be personal or commercial" };
  return { data: { email: email, client: client, type: type, name: name } };
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
      // Non-admins may remove clients only, never staff/admins.
      if (staff.role !== "admin") {
        try {
          var t = await clerk.getUser(body.id);
          var trole = (t && t.public_metadata && t.public_metadata.role) || "client";
          if (isTeamRole(trole)) return respond.json(403, { error: "only admins can remove team members" });
        } catch (ignore) { /* if lookup fails, fall through */ }
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
    var inv = await clerk.createInvitation(checked.data.email, metaFor(checked.data), redirectUrl);
    audit.log({ action: "invite_created", actor: staff.authUserId, target: inv && inv.id, bindlyClientId: checked.data.client });
    return respond.json(201, { ok: true, user: inviteToRow(inv) });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
