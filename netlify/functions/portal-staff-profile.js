// GET /portal-staff-profile -> the CALLER's own directory entry:
//   { name, phone, email }
// PUT /portal-staff-profile { phone, email } -> updates the CALLER's own
//   entry in staff_directory (netlify/functions/utils/staff-directory.js).
//
// Lets any staff/admin login self-serve the phone/email shown on a client's
// Producer/CSR card, instead of a developer editing code. STAFF-ONLY
// (auth.verifyStaff). The row being edited is always the CALLER's own —
// identified server-side via their verified Clerk user id -> Clerk profile
// name, never from anything the browser sends — so one staff login can
// never edit another's contact info.
var auth = require("./utils/auth");
var clerk = require("./utils/clerk");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");
var staffDirectory = require("./utils/staff-directory");

var LIMITS = { email: 254, phone: 40 };
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The caller's own display name, resolved from their Clerk profile — this
// is the join key into staff_directory, so it must come from a verified
// source, not the request body. Assumed to match how Bindly resolves the
// same person's name on a client's producer/csr field (both are "First
// Last" style Clerk/Bindly display names).
async function myName(authUserId) {
  var u = await clerk.getUser(authUserId);
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (["GET", "PUT"].indexOf(method) === -1) return respond.json(405, { error: "method not allowed" });

  var staff;
  try { staff = await auth.verifyStaff(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var limited = ratelimit.guard({ scope: "portal-staff-profile", limit: method === "GET" ? 60 : 20, event: event, ctx: staff });
  if (limited) return limited;

  try {
    var name = await myName(staff.authUserId);
    if (!name) return respond.json(422, { error: "your Clerk profile has no name set — add one in your account settings, then try again" });

    if (method === "GET") {
      var current = await staffDirectory.get(name);
      return respond.json(200, { name: name, phone: current.phone, email: current.email });
    }

    // PUT
    var body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e2) { return respond.json(400, { error: "invalid json" }); }
    var phone = String(body.phone == null ? "" : body.phone).trim().slice(0, LIMITS.phone);
    var email = String(body.email == null ? "" : body.email).trim().slice(0, LIMITS.email);
    if (email && !EMAIL_RE.test(email)) return respond.json(400, { error: "invalid email address" });

    await staffDirectory.upsert(name, { phone: phone, email: email }, staff.authUserId);
    await audit.log({ action: "staff_contact_updated", actor: staff.authUserId, target: name, event: event });
    return respond.json(200, { ok: true, name: name, phone: phone, email: email });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
