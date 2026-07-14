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
// Bindly's API has no attachment field, so we host the file ourselves
// (utils/attachments.js, Netlify Blobs) and append a link to it in the
// notes text the agent sees on the ticket.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");
var coiRequests = require("./utils/coi-requests");
var attachments = require("./utils/attachments");

var LIMITS = {
  holder_name: 200, address1: 120, address2: 120, city: 80, state: 20, zip: 20,
  description: 2000, email: 254, notes: 1000
};
function s(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

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

    // Optional attachment — save it FIRST so a bad file fails fast with a
    // clear error instead of creating a ticket the client thinks failed.
    var attachmentUrl = "";
    if (body.attachment && body.attachment.base64) {
      var saved_attachment = await attachments.save({
        filename: body.attachment.filename,
        contentType: body.attachment.contentType,
        base64: body.attachment.base64
      }, event);
      var host = (event.headers && (event.headers["x-forwarded-host"] || event.headers.host)) || "ipg.team";
      var proto = (event.headers && event.headers["x-forwarded-proto"]) || "https";
      attachmentUrl = proto + "://" + host + "/.netlify/functions/portal-coi-attachment?id=" + encodeURIComponent(saved_attachment.id);
    }
    var notesWithAttachment = attachmentUrl
      ? (notes ? notes + "\n\n" : "") + "Client attached a document: " + attachmentUrl
      : notes;

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
        notes: notesWithAttachment,
        requested_by: ctx.authUserId
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

    await audit.log({
      action: attachmentUrl ? "coi_request_created_with_attachment" : "coi_request_created",
      actor: ctx.authUserId,
      bindlyClientId: ctx.bindlyClientId, target: fields.holder_name, event: event
    });

    return respond.json(201, {
      ok: true, status: "review",
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
