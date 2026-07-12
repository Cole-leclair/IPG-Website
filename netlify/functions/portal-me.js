// GET /portal/me — the signed-in client's profile + account type.
// Maps to PortalData.getAccount() in portal.js (shape: { name, company,
// email, phone, address, producer, csr }).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var ratelimit = require("./utils/ratelimit");
var STAFF_DIRECTORY = require("./utils/staff-directory");

// Pulls one assigned-person field (Producer or CSR) off the client record.
// Bindly's exact field shape for these isn't documented yet, so this tries
// several likely spellings — a nested object, or flat prefixed fields — and
// returns null when no name is present at all, which is what tells the UI to
// hide the card entirely (no card for a client with no producer/CSR set).
function pickPerson(c, key) {
  var candidates = [
    c[key],
    { name: c[key + "_name"], phone: c[key + "_phone"] || c[key + "_direct_line"] || c[key + "_direct"], email: c[key + "_email"] }
  ];
  var name = "", phone = "", email = "";
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (!v) continue;
    if (typeof v === "object") {
      name = name || v.name || v.full_name || "";
      phone = phone || v.phone || v.direct_line || v.direct || "";
      email = email || v.email || "";
    } else if (typeof v === "string" && v.trim()) {
      name = name || v.trim();
    }
  }
  if (!name) return null;
  // Bindly's field may only carry a name — fill in phone/email from IPG's
  // own staff directory when Bindly didn't send them.
  if (!phone || !email) {
    var staff = STAFF_DIRECTORY[name.trim().toLowerCase()];
    if (staff) { phone = phone || staff.phone || ""; email = email || staff.email || ""; }
  }
  return { name: name, phone: phone || "", email: email || "" };
}

// Format Bindly's address (string OR { address1/line1, address2/line2, city,
// state, zip }) into one display line. Tolerant of either field naming so a
// small difference in Bindly's exact keys doesn't blank the field.
function fmtAddress(a) {
  if (!a) return "";
  if (typeof a === "string") return a.trim();
  var l1 = a.address1 || a.line1 || a.street || "";
  var l2 = a.address2 || a.line2 || a.unit || "";
  var street = [l1, l2].filter(Boolean).join(", ");
  var region = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, region].filter(Boolean).join(", ");
}

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var limited = ratelimit.guard({ scope: "portal-me", limit: 60, event: event, ctx: ctx });
  if (limited) return limited;

  try {
    var data = await bindly.getClient(ctx.bindlyClientId);
    var c = (data && data.client) || data || {};
    // Prefer the mailing address for the "Mailing address" row.
    var addr = fmtAddress(c.mailing_address || c.mailingAddress || c.address || c.operating_address);
    return respond.json(200, {
      // accountType comes from the VERIFIED Clerk token, never from Bindly's
      // response — it's what authorization is based on. Bindly's `type` is
      // only informational here.
      accountType: ctx.accountType,
      client: {
        name: c.name || "",
        company: c.dba || c.company || "",
        email: c.email || "",
        phone: c.phone || "",
        address: addr,
        producer: pickPerson(c, "producer"),
        csr: pickPerson(c, "csr")
      }
    });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
