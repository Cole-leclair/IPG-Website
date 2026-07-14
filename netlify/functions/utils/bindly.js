// =====================================================================
// BINDLY — the ONLY module that talks to Bindly's PORTAL READ API.
// Holds the portal API key (server-side env var) so it never reaches the
// browser. Contract per "Bindly Portal Read-API v1" (2026-07-11).
// =====================================================================
//
// Base URL:  https://bindly.to/api/portal/v1   (set as BINDLY_READ_API_URL)
// Auth:      X-API-Key: <portal key>           (set as BINDLY_PORTAL_API_KEY)
//
// IMPORTANT: the portal key is a SEPARATE, read-scoped key — NOT the
// write-only lead-webhook key (BINDLY_API_KEY, used by submission-created.js).
// Keeping them distinct means a leak of one never exposes the other. Never
// fall back to the webhook key here.
//
// Bindly gives out TWO portal keys (production + staging), rotatable
// independently. On Netlify, scope BINDLY_PORTAL_API_KEY per deploy context
// (production vs. deploy-preview/branch) so a staging leak never forces a
// production rotation.

var READ_BASE = (process.env.BINDLY_READ_API_URL || "").trim();
var API_KEY = (process.env.BINDLY_PORTAL_API_KEY || "").trim();

function configured() {
  return Boolean(READ_BASE && API_KEY);
}

// Make one call to the Bindly portal API. Throws an Error with:
//   .status  — the HTTP status to return to OUR client (502 for most upstream
//              failures; 404 and 429 are passed through so callers can react —
//              e.g. cert-holders treats 404 as "this client isn't cert-ready").
//   .upstreamStatus / .upstreamError — what Bindly actually said (for logs).
// `body` is normally a plain object (sent as JSON). Pass a FormData instance
// instead to send multipart/form-data (e.g. createCoiRequestWithFiles below)
// — fetch sets the correct Content-Type + boundary itself, so we must NOT
// set Content-Type ourselves in that case.
async function call(method, path, body) {
  if (!configured()) {
    var e = new Error("bindly portal API not configured — set BINDLY_READ_API_URL + BINDLY_PORTAL_API_KEY");
    e.status = 501;
    throw e;
  }

  var isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  var headers = { "X-API-Key": API_KEY, "Accept": "application/json" };
  if (!isFormData) headers["Content-Type"] = "application/json";

  var res;
  try {
    res = await fetch(READ_BASE.replace(/\/$/, "") + path, {
      method: method,
      headers: headers,
      body: isFormData ? body : (body ? JSON.stringify(body) : undefined)
    });
  } catch (netErr) {
    var eNet = new Error("bindly unreachable: " + netErr.message);
    eNet.status = 502;
    throw eNet;
  }

  var text = await res.text();
  var parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch (pe) { /* non-JSON body */ } }

  if (!res.ok) {
    var msg = (parsed && parsed.error) || ("bindly " + method + " " + path + " -> " + res.status);
    var err = new Error(msg);
    // Pass 404 (resource/client not found) and 429 (rate limit) through so
    // callers can distinguish them; collapse everything else to a generic 502
    // so we never surface Bindly-key/authorization internals to the browser.
    err.status = (res.status === 404 || res.status === 429) ? res.status : 502;
    err.upstreamStatus = res.status;
    err.upstreamError = msg;
    throw err;
  }
  return parsed;
}

module.exports = {
  configured: configured,

  // ---- Onboarding lookup: find a client by name / email / phone (7+ digits).
  // Returns { clients: [{ client_id, name, email, phone, type }] }.
  lookupClient: function (q) {
    return call("GET", "/clients?q=" + encodeURIComponent(q));
  },

  // ---- Profile: name, dba, type, email/phone, mailing + operating addresses,
  // contacts. Keyed by the stable client_id (UUID, survives renames).
  getClient: function (clientId) {
    return call("GET", "/clients/" + encodeURIComponent(clientId));
  },

  // ---- All lines of coverage (also serves as the master-COI summary).
  // Returns { policies: [{ lob, label, carrier, policy_number, effective,
  //           expiration, details }] }.
  getPolicies: function (clientId) {
    return call("GET", "/clients/" + encodeURIComponent(clientId) + "/policies");
  },

  // ---- Every document, categorized, each with a 15-minute signed URL that
  // goes straight to the client's browser (no bytes through us).
  // Returns { documents: [{ filename, category, size, modified, url }] }.
  getDocuments: function (clientId) {
    return call("GET", "/clients/" + encodeURIComponent(clientId) + "/documents");
  },

  // ---- Issued cert-holder COIs. Returns { certificates: [...] } each with the
  // parsed holder name, issue timestamp, and a signed PDF URL.
  getCertificates: function (clientId) {
    return call("GET", "/clients/" + encodeURIComponent(clientId) + "/certificates");
  },

  // ---- Instant self-service issue: runs the SAME ACORD 25 generator IPG's
  // agents use — standard wording off the master COI, holder name + address
  // only. Body: { holder_name, address1, address2?, city, state, zip }
  //   (or raw { lines: [l1,l2,l3,l4] } for full control of the holder box).
  // Returns { success, filename, holder, url }. A 404 here means the client has
  // no COI data yet — treat as "not cert-ready", not a hard error.
  issueCertificate: function (clientId, data) {
    return call("POST", "/clients/" + encodeURIComponent(clientId) + "/certificates", data);
  },

  // ---- Non-standard COI requests (description of operations, special
  // wording…) — used by portal-coi-requests.js. Routes to IPG's Service
  // Center as a ticket, generates a draft ACORD 25 (attached to the ticket,
  // never portal-visible) and gives the agent a one-click send action.
  // Body (per Bindly's 2026-07-14 update): { holder_name, address1, address2,
  // city, state, zip, desc_ops, delivery_email, notes, requested_by }.
  // Create response includes draft_attached (bool). Poll getCoiRequest for
  // status — its response includes delivery_status ("pending"|"sent"),
  // sent_to, sent_at, draft_attached.
  //
  // If data.attachment is present ({ filename, contentType, base64 }), this
  // sends multipart/form-data instead of JSON (per Bindly's 2026-07-14
  // attachment update) — the file lands as a REAL attachment on the ticket
  // next to the draft cert, no hosting on our side. Response then also
  // includes attachments: [filename, ...] confirming what was accepted.
  // Limits are Bindly's (pdf/doc/docx/xls/xlsx/csv/txt/png/jpg/eml/msg,
  // 15MB/file) — but the file still has to reach US first as base64 JSON
  // from the browser, so our own request-size ceiling (~4.2MB raw) is the
  // real limit today, not Bindly's.
  createCoiRequest: function (clientId, data) {
    var path = "/clients/" + encodeURIComponent(clientId) + "/coi-requests";
    var attachment = data && data.attachment;
    if (!attachment) return call("POST", path, data);

    var form = new FormData();
    Object.keys(data).forEach(function (key) {
      if (key === "attachment") return;
      var v = data[key];
      if (v !== undefined && v !== null) form.append(key, v);
    });
    var bytes = Buffer.from(attachment.base64, "base64");
    var blob = new Blob([bytes], { type: attachment.contentType || "application/octet-stream" });
    form.append("file", blob, attachment.filename || "attachment");
    return call("POST", path, form);
  },
  // Option B (not currently used by the portal, kept for a possible future
  // "add another document to an already-submitted request" flow): attach a
  // file to an existing ticket. attachment: { filename, contentType, base64 }.
  addCoiRequestAttachment: function (requestId, attachment) {
    var form = new FormData();
    var bytes = Buffer.from(attachment.base64, "base64");
    var blob = new Blob([bytes], { type: attachment.contentType || "application/octet-stream" });
    form.append("file", blob, attachment.filename || "attachment");
    return call("POST", "/coi-requests/" + encodeURIComponent(requestId) + "/attachments", form);
  },
  getCoiRequest: function (requestId) {
    return call("GET", "/coi-requests/" + encodeURIComponent(requestId));
  },

  // ---- Additional contacts — NATIVE to the Bindly client record (unlimited
  // named contacts with free-text roles). One list, shared with agents in
  // real time, no shadow copy. Each contact has a stable UUID `id`.
  getContacts: function (clientId) {
    return call("GET", "/clients/" + encodeURIComponent(clientId) + "/contacts");
  },
  addContact: function (clientId, data) {
    return call("POST", "/clients/" + encodeURIComponent(clientId) + "/contacts", data);
  },
  // Bindly uses PATCH (partial update) — send only the fields that changed.
  updateContact: function (clientId, contactId, data) {
    return call("PATCH", "/clients/" + encodeURIComponent(clientId) + "/contacts/" + encodeURIComponent(contactId), data);
  },
  removeContact: function (clientId, contactId) {
    return call("DELETE", "/clients/" + encodeURIComponent(clientId) + "/contacts/" + encodeURIComponent(contactId));
  }
};
