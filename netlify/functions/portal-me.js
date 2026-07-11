// GET /portal/me — the signed-in client's profile + account type.
// Maps to PortalData.getAccount() in portal.js.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  try {
    // TODO(Bindly): const client = await bindly.getClient(ctx.bindlyClientId);
    // Return only the fields the portal needs (name, company, email, phone, address).
    return respond.json(200, {
      accountType: ctx.accountType,
      client: null // stub until Bindly read API is wired
    });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
