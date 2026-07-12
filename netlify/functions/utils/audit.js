// =====================================================================
// AUDIT — compliance trail for logins, views, downloads, and changes.
// (GLBA Safeguards Rule expectation for an insurance business — see
// ARCHITECTURE.md §3 `audit_log` and §7.)
//
// Writes to the audit_log table in the portal's Neon database (schema at
// portal/db/schema.sql) once DATABASE_URL is set. Until then — or if the
// insert itself fails — falls back to a structured console.log line so the
// Netlify function logs still hold a trail. Call sites don't change shape
// when the DB availability changes; only this file's behavior does.
//
// Uses @neondatabase/serverless (HTTP-based, no persistent TCP connection)
// rather than the standard `pg` driver — Netlify Functions are short-lived
// and can run many concurrent invocations, and a pooled TCP driver risks
// exhausting Postgres' connection limit across all those instances. Neon's
// HTTP driver issues one fetch() per query, matching how the rest of this
// codebase already talks to everything else (Bindly, Clerk, Clerk's JWKS).
// =====================================================================

var DATABASE_URL = (process.env.DATABASE_URL || "").trim();
var _sql = null;

function configured() {
  return Boolean(DATABASE_URL);
}

function getSql() {
  if (!DATABASE_URL) return null;
  if (!_sql) {
    var neon = require("@neondatabase/serverless").neon;
    _sql = neon(DATABASE_URL);
  }
  return _sql;
}

// Best-effort caller IP/user-agent for the audit row. Mirrors the same
// header-reading logic utils/ratelimit.js uses for its caller key.
function callerIp(event) {
  var h = (event && event.headers) || {};
  return h["x-nf-client-connection-ip"] ||
         (h["x-forwarded-for"] || "").split(",")[0].trim() ||
         h["client-ip"] || null;
}
function callerUserAgent(event) {
  var h = (event && event.headers) || {};
  return h["user-agent"] || h["User-Agent"] || null;
}

// entry: { action, actor, bindlyClientId, target, event }
// `event` is the handler's Netlify event object — optional, only used to
// pull the caller's IP/user-agent for the audit row.
async function log(entry) {
  entry = entry || {};

  // Always emit a structured console line: cheap, immediate in the Netlify
  // function logs, and a redundant record alongside the database row (or
  // the only record, if DATABASE_URL isn't set yet).
  try {
    console.log("AUDIT " + JSON.stringify({
      at: new Date().toISOString(),
      action: entry.action,
      actor: entry.actor || null,
      bindlyClientId: entry.bindlyClientId || null,
      target: entry.target || null
    }));
  } catch (e) {
    // Auditing must never break the request itself.
  }

  var sql = getSql();
  if (!sql) return; // DATABASE_URL not set yet — the console line above is the only trail.

  try {
    await sql.query(
      "insert into audit_log (actor, action, target, bindly_client_id, ip, user_agent) " +
      "values ($1, $2, $3, $4, $5, $6)",
      [
        entry.actor || null,
        entry.action || null,
        entry.target || null,
        entry.bindlyClientId || null,
        callerIp(entry.event),
        callerUserAgent(entry.event)
      ]
    );
  } catch (e2) {
    // A failed DB write must never break the caller's request — the
    // structured console line above already captured this event.
    try { console.log("AUDIT_DB_ERROR " + (e2 && e2.message)); } catch (e3) { /* ignore */ }
  }
}

module.exports = { log: log, configured: configured };
