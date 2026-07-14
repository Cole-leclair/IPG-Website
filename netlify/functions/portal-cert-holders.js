// GET  /portal/cert-holders — issued certificates PLUS any pending
//      description-of-operations requests (see portal-coi-requests.js)
// POST /portal/cert-holders — add a holder (SELF-SERVICE, always instant issue)
// COMMERCIAL ACCOUNTS ONLY. Maps to PortalData.getHolders() / addHolder().
//
// The client only ever supplies holder name + address (street/city/state/zip)
// here, so every certificate THIS endpoint issues is standard ACORD 25
// wording off the master COI — no wording selection, no review routing.
// Bindly runs the SAME generator its agents use and files the PDF in the
// client's Cert Holders folder, so agents see every portal-issued cert in
// Bindly's normal Details view. Requests that DO need review (a description
// of operations) go through portal-coi-requests.js instead, and show up
// here as a "pending" row until resolved.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");
var coiRequests = require("./utils/coi-requests");

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(s) {
  if (!s) return "";
  var d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}

// Field caps mirror the maxlength attributes in portal/index.html — but the
// server is the one that counts. Never trust the browser to enforce limits.
var LIMITS = { holder_name: 200, address1: 120, address2: 120, city: 80, state: 20, zip: 20 };
function s(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }

// Build the one-line display address we hand back to the UI for the holder list.
function displayAddress(f) {
  var street = [f.address1, f.address2].filter(Boolean).join(", ");
  var region = [f.city, [f.state, f.zip].filter(Boolean).join(" ").trim()].filter(Boolean).join(", ");
  return [street, region].filter(Boolean).join(", ");
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== "GET" && method !== "POST") {
    return respond.json(405, { error: "method not allowed" });
  }

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  // POST issues a real ACORD 25 through Bindly, so it's capped tightly; the GET
  // read of the holder list is generous.
  var limited = ratelimit.guard({
    scope: "portal-cert-holders",
    limit: method === "POST" ? 10 : 60,
    event: event, ctx: ctx
  });
  if (limited) return limited;

  // Server-side authorization — hiding the tab is UX; THIS is the real gate.
  if (ctx.accountType !== "commercial") {
    return respond.json(403, { error: "certificates are not available for personal accounts" });
  }

  try {
    if (method === "GET") {
      var data = await bindly.getCertificates(ctx.bindlyClientId);
      var raw = (data && data.certificates) || [];
      var holders = raw.map(function (h, i) {
        return {
          id: h.id || h.certificate_id || ("cert-" + i),
          name: h.holder || h.holder_name || h.name || "",
          address: h.holder_address || h.address || "",
          status: "issued",
          date: fmtDate(h.issued_at || h.created_at || h.modified),
          url: h.url || ""
        };
      });

      // Merge in any still-open description-of-operations requests. A
      // pending row is considered resolved once a REAL issued certificate
      // with the same holder name shows up above — that's Bindly's own
      // signal an agent finished the ticket, without us having to parse
      // whatever ticket-stage strings their Service Center uses.
      var issuedNames = {};
      holders.forEach(function (h) { issuedNames[(h.name || "").trim().toLowerCase()] = true; });
      var pending = await coiRequests.listPending(ctx.bindlyClientId);
      var pendingRows = [];
      for (var i = 0; i < pending.length; i++) {
        var p = pending[i];
        var key = (p.holder_name || "").trim().toLowerCase();
        if (issuedNames[key]) {
          await coiRequests.markResolved(p.id);
          continue;
        }
        pendingRows.push({
          id: p.id,
          name: p.holder_name || "",
          address: p.holder_address || "",
          status: "review", // distinct from a policy's "pending" — see statusBadge in portal.js
          date: fmtDate(p.created_at),
          url: ""
        });
      }

      return respond.json(200, { holders: pendingRows.concat(holders) });
    }

    // POST — add a holder. Always instant issue off the master COI.
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
    if (!fields.holder_name) return respond.json(400, { error: "holder name is required" });
    if (!fields.address1 || !fields.city || !fields.state || !fields.zip) {
      return respond.json(400, { error: "a complete holder address (street, city, state, zip) is required" });
    }

    var issued;
    try {
      issued = await bindly.issueCertificate(ctx.bindlyClientId, fields);
    } catch (err) {
      // A 404 from Bindly here means this client has no COI data on file yet —
      // they aren't cert-ready. Return a clear, client-safe message rather than
      // a generic error. (The portal has no review-fallback flow by design.)
      if (err.upstreamStatus === 404) {
        return respond.json(409, { error: "This account isn’t set up for self-service certificates yet. Please contact IPG and we’ll issue it for you." });
      }
      throw err;
    }

    await audit.log({ action: "cert_issued", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: fields.holder_name, event: event });
    return respond.json(201, { ok: true, status: "issued", holder: {
      id: (issued && issued.filename) || fields.holder_name,
      name: fields.holder_name,
      address: displayAddress(fields),
      status: "issued",
      date: "Just now",
      url: (issued && issued.url) || ""
    }});
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
