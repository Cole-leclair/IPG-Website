// GET    /portal/contacts          -> list this client's additional contacts
// POST   /portal/contacts          -> add a contact { name, role, email, phone }
// PUT    /portal/contacts?id=<id>  -> update a contact (proxied to Bindly PATCH)
// DELETE /portal/contacts?id=<id>  -> remove a contact
// Maps to PortalData.getContacts()/addContact()/updateContact()/removeContact().
//
// These are REFERENCE contacts (billing/safety/HR/etc.) — not portal logins.
// They live NATIVELY on the Bindly client record: Bindly supports unlimited
// named contacts with free-text roles, and a contact added here is visible to
// agents in Bindly instantly (and vice-versa) — one list, no shadow copy, no
// sync. Each contact has a stable UUID `id` from Bindly.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");
var ratelimit = require("./utils/ratelimit");

// Field caps mirror the maxlength attributes in portal/index.html — but the
// server is the one that counts. Never trust the browser to enforce limits.
var LIMITS = { name: 120, role: 80, email: 254, phone: 40 };

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

// Bindly may return a created/updated contact either bare or wrapped in
// { contact: {...} } — normalize so the UI always gets a flat object.
function unwrap(data, fallback) {
  var c = (data && data.contact) || data || {};
  return {
    id: c.id || fallback.id || "",
    name: c.name != null ? c.name : fallback.name,
    role: c.role != null ? c.role : fallback.role,
    email: c.email != null ? c.email : fallback.email,
    phone: c.phone != null ? c.phone : fallback.phone
  };
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (["GET", "POST", "PUT", "DELETE"].indexOf(method) === -1) {
    return respond.json(405, { error: "method not allowed" });
  }

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  // Reads are generous; writes (add/edit/remove a contact) are tighter.
  var limited = ratelimit.guard({
    scope: "portal-contacts",
    limit: method === "GET" ? 60 : 20,
    event: event, ctx: ctx
  });
  if (limited) return limited;

  var id = event.queryStringParameters && event.queryStringParameters.id;

  try {
    if (method === "GET") {
      var data = await bindly.getContacts(ctx.bindlyClientId);
      var raw = (data && data.contacts) || [];
      var contacts = raw.map(function (c) {
        return { id: c.id || "", name: c.name || "", role: c.role || "", email: c.email || "", phone: c.phone || "" };
      });
      return respond.json(200, { contacts: contacts });
    }

    if (method === "POST") {
      var pd;
      try { pd = JSON.parse(event.body || "{}"); }
      catch (e2) { return respond.json(400, { error: "invalid json" }); }
      var checked = cleanContact(pd);
      if (checked.error) return respond.json(400, { error: checked.error });
      var addResp = await bindly.addContact(ctx.bindlyClientId, checked.contact);
      var created = unwrap(addResp, checked.contact);
      await audit.log({ action: "contact_added", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: created.id, event: event });
      return respond.json(201, { ok: true, contact: created });
    }

    if (method === "PUT") {
      if (!id) return respond.json(400, { error: "id query param is required" });
      var ud;
      try { ud = JSON.parse(event.body || "{}"); }
      catch (e3) { return respond.json(400, { error: "invalid json" }); }
      var checkedPut = cleanContact(ud);
      if (checkedPut.error) return respond.json(400, { error: checkedPut.error });
      var updResp = await bindly.updateContact(ctx.bindlyClientId, id, checkedPut.contact);
      var updated = unwrap(updResp, checkedPut.contact);
      updated.id = id;
      await audit.log({ action: "contact_updated", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: id, event: event });
      return respond.json(200, { ok: true, contact: updated });
    }

    // DELETE
    if (!id) return respond.json(400, { error: "id query param is required" });
    await bindly.removeContact(ctx.bindlyClientId, id);
    await audit.log({ action: "contact_removed", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: id, event: event });
    return respond.json(200, { ok: true });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
