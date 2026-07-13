// =====================================================================
// STAFF DIRECTORY — phone/email for whoever Bindly names as a client's
// Producer or CSR (portal-me.js), so the Account tab can show a full
// contact card even though Bindly's producer/csr fields only carry a
// name + (sometimes-blank) email — Bindly doesn't store staff phone
// numbers at all.
//
// Source of truth once DATABASE_URL is set: the staff_directory table in
// Neon (schema: portal/db/schema.sql). Self-service: portal-staff-profile.js
// lets any staff/admin login update their OWN row, instead of asking a
// developer to edit this file. SEED below is the fallback for a name with
// no DB row yet (or before DATABASE_URL is set) — same "swap the plumbing
// later without changing call sites" pattern as utils/audit.js.
//
// Keyed on the lowercased, trimmed name exactly as Bindly resolves it —
// their dev confirmed this is roster-resolved to their own dashboard's
// display name, so it should be stable to match against.
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

var SEED = {
  "cole leclair": { phone: "214-404-9776", email: "cole@ipg.team" },
  "hunter leclair": { phone: "972-322-3933", email: "hunter@ipg.team" },
  "julie nguyen": { phone: "469-679-1951", email: "julie@ipg.team" },
  "ashton warman": { phone: "214-308-0985", email: "ashton@ipg.team" }
};

function keyOf(name) { return String(name || "").trim().toLowerCase(); }

// Looked up once per client dashboard load (portal-me.js). Falls back to
// SEED if the DB has no row for this name yet, isn't configured, or the
// query fails for any reason — a lookup failure must never break the
// client's dashboard.
async function lookup(name) {
  var key = keyOf(name);
  if (!key) return null;
  var sql = getSql();
  if (sql) {
    try {
      var rows = await sql.query("select phone, email from staff_directory where name_key = $1", [key]);
      var row = rows && (rows.rows ? rows.rows[0] : rows[0]);
      if (row) return { phone: row.phone || "", email: row.email || "" };
    } catch (e) {
      try { console.log("STAFF_DIRECTORY_DB_ERROR " + (e && e.message)); } catch (e2) { /* ignore */ }
    }
  }
  return SEED[key] || null;
}

// Reads back the caller's own current row (or the SEED entry, or blanks if
// neither exists yet) — used by portal-staff-profile.js's GET so a staff
// member's settings form starts pre-filled.
async function get(name) {
  var found = await lookup(name);
  return found || { phone: "", email: "" };
}

// Upserts the CALLER's own row. `name` must come from a verified source
// (their own Clerk profile via clerk.getUser, never anything the browser
// claims about whose record this is) so one staff login can never edit
// another's contact info.
async function upsert(name, fields, updatedBy) {
  var key = keyOf(name);
  if (!key) throw new Error("missing name");
  var sql = getSql();
  if (!sql) { var e = new Error("directory not configured — set DATABASE_URL"); e.status = 501; throw e; }
  await sql.query(
    "insert into staff_directory (name_key, name, phone, email, updated_by, updated_at) " +
    "values ($1, $2, $3, $4, $5, now()) " +
    "on conflict (name_key) do update set " +
    "  name = excluded.name, phone = excluded.phone, email = excluded.email, " +
    "  updated_by = excluded.updated_by, updated_at = now()",
    [key, String(name).trim(), fields.phone || "", fields.email || "", updatedBy || null]
  );
}

module.exports = { lookup: lookup, get: get, upsert: upsert };
