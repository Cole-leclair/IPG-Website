// =====================================================================
// ATTACHMENTS — small client-uploaded files for description-of-operations
// COI requests (e.g. their own insurance requirements doc). Bindly's
// coi-requests API has no attachment field of its own, so we host the file
// ourselves (Netlify Blobs) and pass a link in the ticket notes instead —
// see portal-coi-requests.js and portal-coi-attachment.js.
// =====================================================================

var crypto = require("crypto");

// These are classic Lambda-style handlers (exports.handler = async (event) =>
// ...), so Netlify Blobs' zero-config mode needs connectLambda(event) called
// first to pull the store's site/token context out of that event — without
// it, getStore() has nothing to connect to and throws "environment has not
// been configured to use Netlify Blobs".
function getStore(event) {
  var blobs = require("@netlify/blobs");
  if (event) blobs.connectLambda(event);
  return blobs.getStore("coi-attachments");
}

// Netlify Functions have a hard 6MB request payload limit (AWS Lambda
// underneath), and base64 inflates the raw file by ~33% — 4.2MB raw comes
// out to ~5.6MB encoded, leaving real margin under that ceiling. Going much
// higher risks the request failing outright rather than a clean 400.
var MAX_BYTES = 4.2 * 1024 * 1024;
var ALLOWED_TYPES = {
  "application/pdf": true,
  "image/jpeg": true,
  "image/png": true,
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true
};

function err(status, message) {
  var e = new Error(message);
  e.status = status;
  return e;
}

// fields: { filename, contentType, base64 }. Returns { id }.
async function save(fields, event) {
  var contentType = String(fields.contentType || "").toLowerCase();
  if (!ALLOWED_TYPES[contentType]) {
    throw err(400, "Please attach a PDF, Word document, or image (jpg/png).");
  }
  var buf;
  try { buf = Buffer.from(String(fields.base64 || ""), "base64"); }
  catch (e) { throw err(400, "That file couldn’t be read — please try again."); }
  if (!buf.length) throw err(400, "That file appears to be empty.");
  if (buf.length > MAX_BYTES) throw err(400, "That file is too large — please keep attachments under 4.2MB.");

  var id = crypto.randomUUID();
  var store = getStore(event);
  await store.set(id, buf, {
    metadata: {
      contentType: contentType,
      filename: String(fields.filename || "attachment").slice(0, 200)
    }
  });
  return { id: id };
}

// Returns { buffer, contentType, filename } or null if not found.
async function get(id, event) {
  var store = getStore(event);
  var blob = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!blob) return null;
  var meta = blob.metadata || {};
  return {
    buffer: Buffer.from(blob.data),
    contentType: meta.contentType || "application/octet-stream",
    filename: meta.filename || "attachment"
  };
}

module.exports = { save: save, get: get };
