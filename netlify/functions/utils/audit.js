// =====================================================================
// AUDIT — compliance trail for logins, views, downloads, and changes.
// (GLBA Safeguards Rule expectation for an insurance business — see
// ARCHITECTURE.md §3 `audit_log` and §7.)
//
// TODO(DB): once the portal Postgres exists, insert into audit_log here.
// Until then, emit structured JSON so the Netlify function logs hold the
// trail. Call sites don't change when the DB lands — only this file does.
// =====================================================================

function log(entry) {
  try {
    console.log("AUDIT " + JSON.stringify({
      at: new Date().toISOString(),
      action: entry.action,                       // e.g. 'download_document'
      actor: entry.actor || null,                 // authUserId | 'system'
      bindlyClientId: entry.bindlyClientId || null,
      target: entry.target || null                // doc id, contact id, ...
    }));
  } catch (e) {
    // Auditing must never break the request itself.
  }
}

module.exports = { log: log };
