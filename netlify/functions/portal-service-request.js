// POST /portal/service-request — a signed-in client asks IPG to make a change
// (update an address, add/remove a driver or vehicle, request loss runs, etc.).
// Maps to PortalData.submitServiceRequest() in portal.js.
//
// There is no dedicated "service request" endpoint on Bindly's portal READ API,
// so this routes into the SAME place the website's Service Center forms already
// land: Bindly's lead webhook (BINDLY_API_URL + the write-only BINDLY_API_KEY),
// tagged source "IPG Portal - Service" so staff can triage it apart from new
// sales leads. The caller's name/email/phone come from their VERIFIED Bindly
// profile, never from the browser — the client can only supply the topic + text.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");

// The topics offered in the portal UI. Kept server-side too so an arbitrary
// value can't be injected into the lead card; anything else collapses to "Other".
var TOPICS = {
  address: "Update my mailing address",
  driver_vehicle: "Add or remove a driver / vehicle",
  loss_runs: "Request loss runs",
  coverage: "Add or change a coverage",
  billing: "Billing question",
  other: "Other request"
};

function s(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var limited = ratelimit.guard({ scope: "portal-service-request", limit: 20, event: event, ctx: ctx });
  if (limited) return limited;

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e2) { return respond.json(400, { error: "invalid json" }); }

  var topicKey = s(body.topic, 40);
  var topicLabel = TOPICS[topicKey] || TOPICS.other;
  var message = s(body.message, 2000);
  if (!message) return respond.json(400, { error: "please describe what you need" });

  // Sanitize the webhook config the same way submission-created.js does
  // (guards against a pasted "?key=" URL wrapper or stray characters).
  var BINDLY_API_URL = (process.env.BINDLY_API_URL || "").trim().split(/\s+/)[0];
  var rawKey = (process.env.BINDLY_API_KEY || "").trim();
  if (rawKey.indexOf("key=") > -1) rawKey = rawKey.split("key=")[1];
  var keyMatch = rawKey.match(/bnd_[A-Za-z0-9_-]+/);
  var BINDLY_API_KEY = keyMatch ? keyMatch[0] : rawKey.split(/\s+/)[0].replace(/[^\x21-\x7E]/g, "");

  // Look up the caller's contact details from their VERIFIED Bindly id so the
  // service ticket carries who it's from. If the profile lookup fails we still
  // forward the request (with the client id in the notes) rather than lose it.
  var name = "", email = "", phone = "", company = "";
  try {
    var data = await bindly.getClient(ctx.bindlyClientId);
    var c = (data && data.client) || data || {};
    name = c.name || ""; email = c.email || ""; phone = c.phone || "";
    company = c.dba || c.company || "";
  } catch (e3) { /* non-fatal — forward with what we have */ }

  if (!BINDLY_API_URL || !BINDLY_API_KEY) {
    // Not wired (e.g. local dev without the webhook key). Record it so the
    // request isn't silently dropped, and tell the client to call in.
    await audit.log({ action: "service_request_unrouted", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: topicKey, event: event });
    return respond.json(503, { error: "We couldn’t submit that just now. Please call us at (214) 377-1460 and we’ll take care of it." });
  }

  var notes = [
    "Portal service request: " + topicLabel,
    "From client id: " + ctx.bindlyClientId,
    "",
    message
  ].join("\n");

  var lead = {
    name: name, email: email, phone: phone,
    source: "IPG Portal - Service",
    lead_type: ctx.accountType === "commercial" ? "commercial" : "personal",
    notes: notes
  };
  if (company) lead.business = company;

  try {
    var res = await fetch(BINDLY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": BINDLY_API_KEY },
      body: JSON.stringify(lead)
    });
    if (!res.ok) {
      var text = await res.text();
      console.error("service-request: Bindly rejected", res.status, text);
      return respond.json(502, { error: "We couldn’t submit that just now. Please try again or call (214) 377-1460." });
    }
  } catch (err) {
    console.error("service-request: forward failed", err && err.message);
    return respond.json(502, { error: "We couldn’t submit that just now. Please try again or call (214) 377-1460." });
  }

  await audit.log({ action: "service_request", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: topicKey, event: event });
  return respond.json(201, { ok: true });
};
