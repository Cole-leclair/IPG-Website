// GET    /portal/contacts          -> list this client's additional contacts
// POST   /portal/contacts          -> add a contact { name, role, email, phone }
// PUT    /portal/contacts?id=<id>  -> update a contact
// DELETE /portal/contacts?id=<id>  -> remove a contact
// Maps to PortalData.getContacts()/addContact()/updateContact()/removeContact().
//
// These are REFERENCE contacts only (billing/safety/etc.) — not portal logins.
// TODO(DB): Bindly's client model likely tracks one primary contact, not an
// arbitrary list with custom roles, so for now these live in OUR portal DB
// (a `portal_contacts` table — see ARCHITECTURE.md §3), scoped by
// ctx.bindlyClientId. EVENTUALLY these should feed into Bindly instead (Cole
// wants this) — once the Bindly developer confirms their API can read/write
// additional contacts on a client record, swap the DB calls below for
// bindly.getContacts/addContact/updateContact/removeContact and drop the
// portal_contacts table.
var auth = require("./utils/auth");
var respond = require("./utils/respond");
var audit = require("./utils/audit");

// Field caps mirror the maxlength attributes in portal/index.html — but the
// server is the one that counts. Never trust the browser to enforce limits.
var LIMITS = { name: 120, role: 80, email: 254, phone: 40 };
var MAX_CONTACTS = 20; // TODO(DB): reject POST when the client already has this many.

function cleanContact(input) {
  function s(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }
  var c = {
    name: s(input.name, LIMITS.name),
    role: s(input.role, LIMITS.role),
    email: s(input.email, LIMITS.email),
    phone: s(input.phone, LIMITS.phone)
  };
  if (!c.name) return { error: "contact name is required" };
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return { error: "invalid email address" };
  return { contact: c };
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (["GET", "POST", "PUT", "DELETE"].indexOf(method) === -1) {
    return respond.json(405, { error: "method not allowed" });
  }

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var id = event.queryStringParameters && event.queryStringParameters.id;

  try {
    if (method === "GET") {
      // TODO(DB): const contacts = await db.query(
      //   "select id, name, role, email, phone from portal_contacts where bindly_client_id = $1 order by created_at",
      //   [ctx.bindlyClientId]);
      return respond.json(200, { contacts: [] }); // stub
    }

    if (method === "POST") {
      var data;
      try { data = JSON.parse(event.body || "{}"); }
      catch (e2) { return respond.json(400, { error: "invalid json" }); }
      var checked = cleanContact(data);
      if (checked.error) return respond.json(400, { error: checked.error });
      // TODO(DB): const contact = await db.query(
      //   "insert into portal_contacts (bindly_client_id, name, role, email, phone) values ($1,$2,$3,$4,$5) returning *",
      //   [ctx.bindlyClientId, checked.contact.name, checked.contact.role, checked.contact.email, checked.contact.phone]);
      var created = checked.contact;
      created.id = "stub-" + Date.now();
      audit.log({ action: "contact_added", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: created.id });
      return respond.json(201, { ok: true, contact: created });
    }

    if (method === "PUT") {
      if (!id) return respond.json(400, { error: "id query param is required" });
      var updates;
      try { updates = JSON.parse(event.body || "{}"); }
      catch (e3) { return respond.json(400, { error: "invalid json" }); }
      var checkedPut = cleanContact(updates);
      if (checkedPut.error) return respond.json(400, { error: checkedPut.error });
      // TODO(DB): update the row WHERE id = $1 AND bindly_client_id = $2 (never trust
      // an id alone — always scope the update to the caller's own client).
      var updated = checkedPut.contact;
      updated.id = id;
      audit.log({ action: "contact_updated", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: id });
      return respond.json(200, { ok: true, contact: updated });
    }

    // DELETE
    if (!id) return respond.json(400, { error: "id query param is required" });
    // TODO(DB): delete WHERE id = $1 AND bindly_client_id = $2 (same scoping rule).
    audit.log({ action: "contact_removed", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: id });
    return respond.json(200, { ok: true });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
