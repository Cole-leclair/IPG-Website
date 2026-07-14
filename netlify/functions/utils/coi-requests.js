// =====================================================================
// COI REQUESTS — tracks description-of-operations certificate requests
// (portal-coi-requests.js), which need an IPG agent's review before
// issuing (unlike the instant name+address certs in portal-cert-holders.js).
//
// Bindly's coi-requests API has no "list pending for this client" endpoint
// and no field for "email the finished cert to" — so this table is OUR
// record of what's outstanding: which Bindly ticket (bindly_request_id)
// belongs to which client, so portal-cert-holders.js can show it as a
// "Pending review" row and resolve it once a real matching certificate
// shows up in Bindly's own certificates list.
//
// Reuses the cert_holders table (schema: portal/db/schema.sql) — it went
// unused after the 2026-07-10 self-service simplification, and its shape
// (holder_name, holder_address, status, timestamps) already fit this need.
// =====================================================================

var DATABASE_URL = (process.env.DATABASE_URL || "").trim();
var _sql = null;
function getSql() {
  if (!DATABASE_URL) return null;
  if (!_sql) {
    var neon = require("@neondatabase/serverless").neon;
    _sql = neon(DATABASE_URL);
  }
  return _sql;
}

// Creates the pending record. Throws (501) if DATABASE_URL isn't set —
// callers should treat that as "review requests aren't available yet"
// rather than silently losing track of a real Bindly ticket.
async function create(fields) {
  var sql = getSql();
  if (!sql) { var e = new Error("COI request tracking not configured — set DATABASE_URL"); e.status = 501; throw e; }
  var rows = await sql.query(
    "insert into cert_holders (bindly_client_id, holder_name, holder_address, description_of_operations, bindly_request_id, status) " +
    "values ($1, $2, $3, $4, $5, 'pending') returning id, created_at",
    [fields.bindlyClientId, fields.holderName, fields.holderAddress || "", fields.descriptionOfOperations, fields.bindlyRequestId]
  );
  var row = rows && (rows.rows ? rows.rows[0] : rows[0]);
  return row || {};
}

// All still-open requests for this client. Missing DB config just means no
// pending rows show up — the instant-issue flow must never depend on this.
async function listPending(bindlyClientId) {
  var sql = getSql();
  if (!sql) return [];
  try {
    var rows = await sql.query(
      "select id, holder_name, holder_address, bindly_request_id, status, created_at " +
      "from cert_holders where bindly_client_id = $1 and status = 'pending' order by created_at desc",
      [bindlyClientId]
    );
    return (rows && (rows.rows || rows)) || [];
  } catch (e) {
    try { console.log("COI_REQUESTS_DB_ERROR " + (e && e.message)); } catch (e2) { /* ignore */ }
    return [];
  }
}

async function markResolved(id) {
  var sql = getSql();
  if (!sql) return;
  try { await sql.query("update cert_holders set status = 'resolved', updated_at = now() where id = $1", [id]); }
  catch (e) { try { console.log("COI_REQUESTS_DB_ERROR " + (e && e.message)); } catch (e2) { /* ignore */ } }
}

module.exports = { create: create, listPending: listPending, markResolved: markResolved };
