// GET /portal/me — the signed-in client's profile + account type.
// Maps to PortalData.getAccount() in portal.js (shape: { name, company,
// email, phone, address, producer, csrs }).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var ratelimit = require("./utils/ratelimit");
var staffDirectory = require("./utils/staff-directory");

// Bindly's confirmed shape (per their dev, 2026-07-12) on GET /clients/{id}:
// `producer` and `csr` are each either an object { name, email } (name is
// roster-resolved to Bindly's own display name; email can be "" if the
// person isn't a Bindly login) or null (genuinely unassigned — hide the
// card, don't show a blank one). `additional_csrs` is an array of the same
// shape for clients with secondary CSRs, often empty.
//
// Bindly doesn't store staff phone numbers at all, so phone always comes
// from IPG's own staff directory (self-service editable — see
// portal-staff-profile.js), keyed by the resolved name. The directory is
// also the fallback for email if Bindly's copy is blank.
async function resolvePerson(p) {
  if (!p || !p.name) return null;
  var staff = await staffDirectory.lookup(p.name);
  return {
    name: p.name,
    email: p.email || (staff && staff.email) || "",
    phone: (staff && staff.phone) || ""
  };
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
    var producer = await resolvePerson(c.producer);
    var csrs = (await Promise.all([c.csr].concat(c.additional_csrs || []).map(resolvePerson))).filter(Boolean);
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
        producer: producer,
        csrs: csrs
      }
    });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
