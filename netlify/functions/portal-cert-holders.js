// GET  /portal/cert-holders — holders/certificates on the master COI
// POST /portal/cert-holders — add a holder (SELF-SERVICE, always instant issue)
// COMMERCIAL ACCOUNTS ONLY. Maps to PortalData.getHolders() / addHolder().
// The client only ever supplies name/address (see portal/index.html), so every
// holder is standard coverage off the master COI — no wording selection, no
// review routing.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== "GET" && method !== "POST") {
    return respond.json(405, { error: "method not allowed" });
  }

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  if (ctx.accountType !== "commercial") {
    return respond.json(403, { error: "certificates are not available for personal accounts" });
  }

  try {
    if (method === "GET") {
      // TODO(Bindly): const holders = await bindly.getHolders(ctx.bindlyClientId);
      // Shape each as { id, name, address, status, date, url }.
      return respond.json(200, { holders: [] }); // stub
    }

    // POST — add a holder. Always instant issue off the master COI.
    var data;
    try { data = JSON.parse(event.body || "{}"); }
    catch (e2) { return respond.json(400, { error: "invalid json" }); }
    var name = String(data.name == null ? "" : data.name).trim().slice(0, 200);
    var address = String(data.address == null ? "" : data.address).trim().slice(0, 300);
    if (!name) return respond.json(400, { error: "holder name is required" });

    // TODO(Bindly): const issued = await bindly.issueCertificate(ctx.bindlyClientId, { name, address });
    //   -> generates the ACORD 25 from the master COI, returns { holder, url }.
    // TODO(DB): dedupe recent identical (name, address) requests so a retry or
    // double-submit can't issue the same certificate twice.
    audit.log({ action: "cert_issued", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: name });
    return respond.json(201, { ok: true, status: "issued", holder: {
      name: name, address: address,
      status: "issued", date: "Just now", url: null // stub: real signed URL from Bindly
    }});
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
