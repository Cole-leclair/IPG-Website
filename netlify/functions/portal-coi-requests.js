// POST /portal/coi-requests — a certificate request that needs an IPG
// agent's review (the client entered a description of operations, so it
// can't be the standard instant name+address cert from
// portal-cert-holders.js). COMMERCIAL ACCOUNTS ONLY.
//
// Bindly's coi-requests API (updated 2026-07-14) now takes dedicated fields —
// holder_name/address1/address2/city/state/zip/desc_ops/delivery_email/notes/
// requested_by — persists all of them on the ticket, generates a draft ACORD
// 25 (with the description of operations on the PDF) and attaches it at
// request time, and gives the agent a one-click "send to {delivery_email}"
// action. The draft never appears in GET /certificates or gets a portal-
// facing URL until an agent actually sends it. The ticket id is saved to our
// own cert_holders table (see utils/coi-requests.js) so portal-cert-holders.js
// can show it as "Pending review" until Bindly's delivery_status flips to
// "sent" (checked fresh each time the holder list loads).
//
// Optional client attachment (e.g. their own insurance requirements doc):
// Bindly added native multipart attachment support the same day (2026-07-14,
// later) — bindly.createCoiRequest sends it straight through as a real
// ticket attachment next to the draft cert. We don't host anything anymore
// (the earlier Netlify Blobs approach was removed). Bindly's own limits are
// generous (15MB/file, more file types), but the file still reaches US first
// as base64 JSON from the browser, so OUR request-size ceiling (~4.2MB raw)
// is the real limit today.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");
var coiRequests = require("./utils/coi-requests");

var LIMITS = {
  holder_name: 200, address1: 120, address2: 120, city: 80, state: 20, zip: 20,
  description: 2000, email: 254, notes: 1000
};
function s(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

// Mirrors Bindly's accepted types for coi-request attachments.
var ATTACHMENT_MAX_BYTES = 4.2 * 1024 * 1024;
var ATTACHMENT_ALLOWED_TYPES = {
  "application/pdf": true,
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/vnd.ms-excel": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "text/csv": true, "text/plain": true,
  "image/png": true, "image/jpeg": true,
  "message/rfc822": true // .eml
};

function displayAddress(f) {
  var street = [f.address1, f.address2].filter(Boolean).join(", ");
  var region = [f.city, [f.state, f.zip].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ");
  return [street, region].filter(Boolean).join(", ");
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  // Same tight cap as instant cert issuance — this still creates a real
  // Bindly ticket per submission.
  var limited = ratelimit.guard({ scope: "portal-coi-requests", limit: 10, event: event, ctx: ctx });
  if (limited) return limited;

  if (ctx.accountType !== "commercial") {
    return respond.json(403, { error: "certificates are not available for personal accounts" });
  }

  try {
    var body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (e2) { return respond.json(400, { error: "invalid json" }); }

    var fields = {
      holder_name: s(body.name || body.holder_name, LIMITS.holder_name),
      address1: s(body.address1, LIMITS.address1),
      address2: s(body.address2, LIMITS.address2),
      city: s(body.city, LIMITS.city),
      state: s(body.state, LIMITS.state),
      zip: s(body.zip, LIMITS.zip)
    };
    var description = s(body.description_of_operations, LIMITS.description);
    var email = s(body.email, LIMITS.email);
    var notes = s(body.notes, LIMITS.notes);

    if (!fields.holder_name) return respond.json(400, { error: "holder name is required" });
    if (!fields.address1 || !fields.city || !fields.state || !fields.zip) {
      return respond.json(400, { error: "a complete holder address (street, city, state, zip) is required" });
    }
    if (!description) return respond.json(400, { error: "description of operations is required" });
    if (!/^\S+@\S+\.\S+$/.test(email)) return respond.json(400, { error: "a valid email is required" });

    // Optional attachment — validate BEFORE calling Bindly so a bad file
    // fails fast with a clear error instead of creating a half-done ticket.
    var attachment = null;
    var hasAttachment = !!(body.attachment && body.attachment.base64);
    if (hasAttachment) {
      var contentType = String(body.attachment.contentType || "").toLowerCase();
      if (!ATTACHMENT_ALLOWED_TYPES[contentType]) {
        return respond.json(400, { error: "That file type isn’t supported — try a PDF, Word/Excel doc, image, or text file." });
      }
      var rawBytes;
      try { rawBytes = Buffer.from(String(body.attachment.base64), "base64"); }
      catch (e4) { return respond.json(400, { error: "That file couldn’t be read — please try again." }); }
      if (!rawBytes.length) return respond.json(400, { error: "That file appears to be empty." });
      if (rawBytes.length > ATTACHMENT_MAX_BYTES) {
        return respond.json(400, { error: "That file is too large — please keep attachments under 4.2MB." });
      }
      attachment = {
        filename: s(body.attachment.filename, 200) || "attachment",
        contentType: contentType,
        base64: body.attachment.base64
      };
    }

    var created;
    try {
      created = await bindly.createCoiRequest(ctx.bindlyClientId, {
        holder_name: fields.holder_name,
        address1: fields.address1,
        address2: fields.address2,
        city: fields.city,
        state: fields.state,
        zip: fields.zip,
        desc_ops: description,
        delivery_email: email,
        notes: notes,
        requested_by: ctx.authUserId,
        attachment: attachment
      });
    } catch (err) {
      if (err.upstreamStatus === 404) {
        return respond.json(409, { error: "This account isn’t set up for certificate requests yet. Please contact IPG directly." });
      }
      throw err;
    }

    var requestId = created && created.request_id;
    var address = displayAddress(fields);
    var saved = null;
    if (requestId) {
      try {
        saved = await coiRequests.create({
          bindlyClientId: ctx.bindlyClientId,
          holderName: fields.holder_name,
          holderAddress: address,
          descriptionOfOperations: description,
          bindlyRequestId: requestId
        });
      } catch (dbErr) {
        // The Bindly ticket is real either way — a tracking-row failure
        // shouldn't be reported to the client as the request failing.
        try { console.log("COI_REQUESTS_SAVE_ERROR " + (dbErr && dbErr.message)); } catch (e3) { /* ignore */ }
      }
    }

    // Bindly's own advice: the response lists exactly what it accepted —
    // don't assume the attachment made it on just because we sent it.
    var acceptedAttachment = !!(hasAttachment && created && Array.isArray(created.attachments) && created.attachments.length);

    await audit.log({
      action: hasAttachment ? "coi_request_created_with_attachment" : "coi_request_created",
      actor: ctx.authUserId,
      bindlyClientId: ctx.bindlyClientId, target: fields.holder_name, event: event
    });

    return respond.json(201, {
      ok: true, status: "review",
      attachmentAccepted: hasAttachment ? acceptedAttachment : null,
      holder: {
        id: (saved && saved.id) || requestId || fields.holder_name,
        name: fields.holder_name,
        address: address,
        status: "review", // distinct from a policy's "pending" — see statusBadge in portal.js
        date: "Just now",
        url: ""
      }
    });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
