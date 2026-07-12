// POST /webhooks/bindly — inbound events FROM Bindly (Phase 4).
// e.g. document added, policy renewed, certificate issued -> invalidate any
// cache and/or notify the client. Only wire this up once you confirm Bindly
// can push signed webhooks (ARCHITECTURE.md §9, question 5).
var respond = require("./utils/respond");
var ratelimit = require("./utils/ratelimit");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return respond.json(405, { error: "method not allowed" });

  // Public POST endpoint — throttle per source IP so an unsigned flood can't
  // spin the function. (Real Bindly traffic stays well under this.)
  var limited = ratelimit.guard({ scope: "webhooks-bindly", limit: 60, event: event });
  if (limited) return limited;

  // TODO(Bindly): verify the webhook signature before trusting the payload.
  // Reject anything that doesn't carry a valid signature from Bindly.
  var signature = event.headers && (event.headers["x-bindly-signature"] || event.headers["X-Bindly-Signature"]);
  if (!signature) {
    return respond.json(401, { error: "missing webhook signature" });
  }

  var payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch (e) { return respond.json(400, { error: "invalid json" }); }

  switch (payload.event) {
    case "document.added":
    case "policy.renewed":
    case "certificate.issued":
      // TODO: invalidate cache for payload.client_id and/or enqueue a notification.
      break;
    default:
      // Unknown event types are acknowledged so Bindly doesn't retry forever.
      break;
  }

  return respond.json(200, { received: true });
};
