// GET /portal/me — the signed-in client's profile + account type.
// Maps to PortalData.getAccount() in portal.js (shape: { name, company,
// email, phone, address }).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");

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
        address: addr
      }
    });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
