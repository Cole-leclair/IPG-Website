// GET /portal/policies — the signed-in client's policies.
// Maps to PortalData.getPolicies() in portal.js.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  try {
    // TODO(Bindly): const policies = await bindly.getPolicies(ctx.bindlyClientId);
    // Shape each as { type, number, carrier, term, status }.
    var policies = []; // stub
    return respond.json(200, { policies: policies });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
