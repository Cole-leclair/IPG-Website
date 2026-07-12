// GET /portal/documents — the signed-in client's documents.
// Maps to PortalData.getDocuments() (shape: { name, kind, date, url }).
//
// Bindly returns each document WITH a short-lived (15-min) HMAC-signed URL that
// goes straight to the client's browser — no API key in it, no bytes through
// our server. So there's no separate "get a download link" call: the link is
// in the listing. (Trade-off: because the file bytes never pass through us, we
// audit at LISTING granularity — "client viewed their documents" — rather than
// logging each individual file open. Certificate issuance and contact changes,
// which DO go through our POST endpoints, are still audited per-action.)
//
// The signed URL expires 15 min after the listing loads. If a client opens a
// stale link, Bindly returns 410 — a future enhancement can re-fetch the
// listing on click for a fresh link (see Master Reference §14).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(s) {
  if (!s) return "";
  var d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var limited = ratelimit.guard({ scope: "portal-documents", limit: 60, event: event, ctx: ctx });
  if (limited) return limited;

  try {
    var data = await bindly.getDocuments(ctx.bindlyClientId);
    var raw = (data && data.documents) || [];
    var documents = raw.map(function (d) {
      return {
        name: d.filename || "",
        kind: d.category || "",
        date: fmtDate(d.modified),
        url: d.url || ""
      };
    });
    audit.log({ action: "documents_listed", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: String(documents.length) });
    return respond.json(200, { documents: documents });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
