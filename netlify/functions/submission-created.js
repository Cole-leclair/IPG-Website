// Netlify auto-runs this function on EVERY successful form submission.
// (The filename "submission-created" is a special Netlify event trigger —
//  don't rename it.) It forwards each captured lead into Bindly.
//
// -------------------------------------------------------------------------
// SECRETS LIVE IN NETLIFY ENV VARS ONLY — never hard-code them here.
// Set these in Netlify: Site configuration > Environment variables
//     BINDLY_API_URL   https://bindly.to/api/webhook/leads   (clean, no ?key=)
//     BINDLY_API_KEY   the bnd_… webhook key from your Bindly developer
// The key is sent as an X-API-Key header, so it never appears in a URL,
// in the page HTML, or in anything shipped to the browser.
// Until both vars are set, this no-ops safely — Netlify still captures every
// submission and emails your team, so no lead is ever lost.
// -------------------------------------------------------------------------

// Per-form routing. biz=true => Bindly lead_type "commercial", else "personal".
// typeIsCoverage=true => the form's "type" field is a line of business we can
// surface as Bindly's `coverage`; otherwise it goes into notes.
var FORMS = {
  "home-quote":            { biz: false, typeIsCoverage: true,  label: "Website quote (Home page)" },
  "contact-quote":         { biz: false, typeIsCoverage: true,  label: "Website quote (Contact page)" },
  "personal-quote":        { biz: false, typeIsCoverage: true,  label: "Personal lines quote" },
  "business-quote":        { biz: true,  typeIsCoverage: true,  label: "Business insurance quote" },
  "benefits-quote":        { biz: true,  typeIsCoverage: true,  label: "Employee benefits quote" },
  "service-claim":         { biz: false, typeIsCoverage: false, label: "Claim report" },
  "service-payment":       { biz: false, typeIsCoverage: false, label: "Payment request" },
  "service-certificate":   { biz: true,  typeIsCoverage: false, label: "Certificate (COI) request" },
  "service-policy-change": { biz: false, typeIsCoverage: false, label: "Policy change request" }
};

exports.handler = async function (event) {
  try {
    var body = JSON.parse(event.body || "{}");
    var payload = body.payload || {};
    var data = payload.data || {};
    var formName = payload.form_name || "";
    var cfg = FORMS[formName] || { biz: false, typeIsCoverage: false, label: "Website submission" };

    // Sanitize env values against copy-paste artifacts (trailing text, a
    // pasted "?key=" URL wrapper, stray whitespace, or non-ASCII characters
    // like a curly quote that would otherwise crash the header conversion).
    var BINDLY_API_URL = (process.env.BINDLY_API_URL || "").trim().split(/\s+/)[0];
    var rawKey = (process.env.BINDLY_API_KEY || "").trim();
    if (rawKey.indexOf("key=") > -1) rawKey = rawKey.split("key=")[1];
    var keyMatch = rawKey.match(/bnd_[A-Za-z0-9_-]+/);
    var BINDLY_API_KEY = keyMatch ? keyMatch[0] : rawKey.split(/\s+/)[0].replace(/[^\x21-\x7E]/g, "");

    // Not wired yet — capture + email already happened; just exit cleanly.
    if (!BINDLY_API_URL || !BINDLY_API_KEY) {
      console.log("Bindly not configured; submission captured only:", formName);
      return { statusCode: 200, body: "captured (Bindly not configured)" };
    }

    // commercial if the form is a business/benefits form, OR the visitor
    // explicitly picked Business / Employee Benefits on a general quote form.
    var t = (data.type || "").toLowerCase();
    var isCommercial = cfg.biz || t.indexOf("business") > -1 || t.indexOf("benefit") > -1;

    // Roll every extra detail into notes so nothing is lost on the lead card.
    var notes = [];
    notes.push("Request: " + cfg.label);
    if (data.type && !cfg.typeIsCoverage) notes.push("Type: " + data.type);
    if (data.policy)       notes.push("Policy #: " + data.policy);
    if (data.carrier)      notes.push("Current carrier: " + data.carrier);
    if (data.holder)       notes.push("Certificate holder: " + data.holder);
    if (data.date)         notes.push("Date of loss: " + data.date);
    if (data.requirements) notes.push("Requirements: " + data.requirements);
    Object.keys(data).forEach(function (k) {
      if (/^declarations(-\d+)?$/.test(k) && data[k]) notes.push("Declaration pages / policy: " + data[k]);
      if (/^census(-\d+)?$/.test(k) && data[k]) notes.push("Group employee census: " + data[k]);
    });
    if (data.details)      notes.push(data.details);
    if (data.message)      notes.push(data.message);

    // Service tasks (COI, claim, payment, policy change) are existing-client
    // requests, not new sales leads — tag their source distinctly so they can
    // be routed away from new-business follow-up. Quotes stay "IPG Website".
    var isService = formName.indexOf("service-") === 0;

    var lead = {
      name: data.name || "",
      email: data.email || "",
      phone: data.phone || "",
      source: isService ? "IPG Website - Service" : "IPG Website",  // shows on the lead card; do NOT omit
      lead_type: isCommercial ? "commercial" : "personal",
      notes: notes.join("\n")
    };
    if (cfg.typeIsCoverage && data.type) lead.coverage = data.type;
    if (data.company) lead.business = data.company;

    var res = await fetch(BINDLY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": BINDLY_API_KEY
      },
      body: JSON.stringify(lead)
    });

    if (!res.ok) {
      var text = await res.text();
      console.error("Bindly rejected the lead:", res.status, text);
      return { statusCode: 200, body: "captured; Bindly returned " + res.status };
    }

    console.log("Lead forwarded to Bindly:", formName, lead.email || lead.phone);
    return { statusCode: 200, body: "forwarded to Bindly" };
  } catch (err) {
    // Never fail hard — the submission is already safely captured by Netlify.
    console.error("submission-created error:", err);
    return { statusCode: 200, body: "captured; forwarding errored" };
  }
};
