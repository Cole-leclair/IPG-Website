// =====================================================================
// BINDLY — the ONLY module that talks to Bindly. Holds the API key
// (server-side env var) so it never reaches the browser.
// =====================================================================
//
// IMPORTANT: BINDLY_API_URL today points at the write-only LEAD WEBHOOK
// (bindly.to/api/webhook/leads) used by submission-created.js. The portal
// needs Bindly's READ API, which is almost certainly a different base URL.
// Confirm with the Bindly developer and set BINDLY_READ_API_URL, then fill
// in the endpoint paths below (see ARCHITECTURE.md §9).

var READ_BASE = process.env.BINDLY_READ_API_URL || "";
var API_KEY = (process.env.BINDLY_API_KEY || "").trim();

function configured() {
  return Boolean(READ_BASE && API_KEY);
}

async function call(method, path, body) {
  if (!configured()) {
    var e = new Error("bindly read API not configured — set BINDLY_READ_API_URL");
    e.status = 501;
    throw e;
  }
  var res = await fetch(READ_BASE.replace(/\/$/, "") + path, {
    method: method,
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    var err = new Error("bindly " + method + " " + path + " -> " + res.status);
    err.status = 502;
    throw err;
  }
  return res.json();
}

// TODO(Bindly): confirm the exact paths + response shapes with the developer.
module.exports = {
  configured: configured,
  getClient:      function (clientId) { return call("GET", "/clients/" + clientId); },
  getPolicies:    function (clientId) { return call("GET", "/clients/" + clientId + "/policies"); },
  getDocuments:   function (clientId) { return call("GET", "/clients/" + clientId + "/documents"); },
  getDocumentUrl: function (clientId, docId) { return call("GET", "/clients/" + clientId + "/documents/" + docId + "/url"); },
  // Master certificate + self-service holders.
  // NOTE: getMasterCoi has no caller — the master-COI summary panel was
  // removed from the portal UI 2026-07-10. Kept only for a possible
  // staff/back-office view (ARCHITECTURE.md §9 q7); delete if that never lands.
  getMasterCoi:   function (clientId) { return call("GET", "/clients/" + clientId + "/master-certificate"); },
  getHolders:     function (clientId) { return call("GET", "/clients/" + clientId + "/master-certificate/holders"); },
  // Instant issue: generate the ACORD 25 from the master COI for a new holder.
  // Should return { holder, url } where url is a short-lived signed link.
  issueCertificate: function (clientId, data) { return call("POST", "/clients/" + clientId + "/master-certificate/holders", data); },

  // TODO(Bindly): NOT YET CONFIRMED — ask whether Bindly's client model
  // supports multiple named contacts with custom roles (ARCHITECTURE.md §9
  // q10). Until confirmed, portal-contacts.js uses the portal DB instead of
  // these. Paths below are a guess for when/if Bindly says yes.
  getContacts:    function (clientId) { return call("GET", "/clients/" + clientId + "/contacts"); },
  addContact:     function (clientId, data) { return call("POST", "/clients/" + clientId + "/contacts", data); },
  updateContact:  function (clientId, contactId, data) { return call("PUT", "/clients/" + clientId + "/contacts/" + contactId, data); },
  removeContact:  function (clientId, contactId) { return call("DELETE", "/clients/" + clientId + "/contacts/" + contactId); }
};
