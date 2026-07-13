// GET /portal/documents — the signed-in client's documents.
// Maps to PortalData.getDocuments() (shape: { name, kind, date, year, url }).
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
// Best available year for grouping. Bindly's /documents doesn't carry a
// policy-term/effective year (only `modified`, the upload/edit date) — asked
// Bindly's developer whether a real term year can be added (Q14 follow-up).
// Until then this is a proxy, not the policy year: a corrected re-upload of
// an old document would file it under the year it was RE-uploaded, not the
// year it covers.
function yearOf(s) {
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getFullYear();
}

// Client-safe categories only — Bindly's /documents endpoint returns "every
// file, categorized" with no per-document visibility flag (asked about in
// portal/Bindly Read-API Questions, Q14), so this allow-list is the only
// thing standing between a file placed in a staff-only category (Quotes,
// ACORD Apps, Miscellaneous, or anything new/unreviewed) and a client seeing
// it. Fail-closed on purpose: an unrecognized category is hidden, not shown.
// "Cert Holders" stays in because it's the client's OWN issued certificates
// (self-service, via the Certificates tab) — not a staff-internal category.
// Covers both spellings we've seen for the same thing ("Declarations" vs
// "Dec Pages").
var CLIENT_VISIBLE_CATEGORIES = ["policies", "id cards", "declarations", "dec pages",
  "cois", "cert holders", "loss runs"];
function isClientVisible(category) {
  return CLIENT_VISIBLE_CATEGORIES.indexOf(String(category || "").trim().toLowerCase()) > -1;
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
    var documents = raw
      .filter(function (d) { return isClientVisible(d.category); })
      .map(function (d) {
        return {
          name: d.filename || "",
          kind: d.category || "",
          date: fmtDate(d.modified),
          year: yearOf(d.modified),
          url: d.url || ""
        };
      });
    var hidden = raw.length - documents.length;
    await audit.log({
      action: "documents_listed", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId,
      target: String(documents.length) + (hidden ? " (" + hidden + " hidden by category)" : ""), event: event
    });
    return respond.json(200, { documents: documents });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
