// GET /portal/policies — the signed-in client's policies (all lines of
// coverage). Maps to PortalData.getPolicies() (shape: { type, number,
// carrier, term, status, renewsSoon, expiresOn, daysToRenew, coverages }).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var ratelimit = require("./utils/ratelimit");

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Parse Bindly's "MM/DD/YYYY" (also tolerates ISO "YYYY-MM-DD"). Returns a Date
// or null. Built without Date parsing of ambiguous strings so the result is
// consistent regardless of server locale.
function parseDate(s) {
  if (!s) return null;
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}
function monthYear(d) { return d ? MONTHS[d.getMonth()] + " " + d.getFullYear() : ""; }
function isoDay(d) {
  if (!d) return "";
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

// Turn Bindly's free-form `details` object (e.g. { each_occ: "1,000,000",
// gen_agg: "2,000,000", deductible: "2,500" }) into an ordered, display-ready
// list of { label, value } coverage lines. Bindly hasn't published a fixed
// schema for this object, so we humanize any key we don't recognize rather
// than dropping it — better to show "Med Pay: $5,000" than nothing.
var COVERAGE_LABELS = {
  each_occ: "Each Occurrence", each_occurrence: "Each Occurrence",
  gen_agg: "General Aggregate", general_aggregate: "General Aggregate",
  aggregate: "Aggregate",
  products_agg: "Products / Completed Ops", prod_comp_ops: "Products / Completed Ops",
  personal_injury: "Personal & Advertising Injury", pers_adv_injury: "Personal & Advertising Injury",
  damage_to_premises: "Damage to Rented Premises", fire_damage: "Damage to Rented Premises",
  med_exp: "Medical Expense", med_pay: "Medical Payments",
  deductible: "Deductible", ded: "Deductible",
  each_accident: "Each Accident", bodily_injury: "Bodily Injury",
  property_damage: "Property Damage", combined_single_limit: "Combined Single Limit", csl: "Combined Single Limit",
  el_each_accident: "E.L. Each Accident", el_disease_each: "E.L. Disease — Each Employee",
  el_disease_policy: "E.L. Disease — Policy Limit",
  coverage_a: "Dwelling (Coverage A)", coverage_b: "Other Structures (Coverage B)",
  coverage_c: "Personal Property (Coverage C)", coverage_d: "Loss of Use (Coverage D)",
  coverage_e: "Personal Liability (Coverage E)", coverage_f: "Medical Payments (Coverage F)",
  wind_deductible: "Wind / Hail Deductible", hurricane_deductible: "Hurricane Deductible"
};
function humanizeKey(k) {
  if (COVERAGE_LABELS[k]) return COVERAGE_LABELS[k];
  return String(k).replace(/[_-]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
// Prefix "$" only for plain money-looking values (digits + commas), so we
// don't mangle things like "Included", "Yes", or a percentage. Plain
// free-text values are capitalized ("active" -> "Active") since Bindly's
// details object isn't guaranteed to send display-cased text.
function fmtValue(v) {
  var s = String(v == null ? "" : v).trim();
  if (s === "") return "";
  if (/^\$/.test(s)) return s;
  if (/^[\d,]+(\.\d+)?$/.test(s)) return "$" + s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function coverages(details) {
  if (!details || typeof details !== "object") return [];
  return Object.keys(details).reduce(function (acc, k) {
    var raw = details[k];
    // Skip ACORD-style boolean endorsement flags (Additional Insured, Claims
    // Made, Primary & Noncontributory, Subrogation Waived, and similar
    // yes/no attributes) — these aren't coverage limits/deductibles, and
    // showing a shortened field name next to "true"/"false" isn't
    // client-friendly. Coverage details are for limits and dollar amounts.
    if (typeof raw === "boolean" || /^(true|false)$/i.test(String(raw).trim())) return acc;
    var val = fmtValue(raw);
    if (val !== "") acc.push({ label: humanizeKey(k), value: val });
    return acc;
  }, []);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var limited = ratelimit.guard({ scope: "portal-policies", limit: 60, event: event, ctx: ctx });
  if (limited) return limited;

  try {
    var data = await bindly.getPolicies(ctx.bindlyClientId);
    var raw = (data && data.policies) || [];
    var now = new Date();
    var soonMs = 60 * 24 * 60 * 60 * 1000; // "renewing soon" = within 60 days

    var policies = raw.map(function (p) {
      var eff = parseDate(p.effective);
      var exp = parseDate(p.expiration);
      var term = [monthYear(eff), monthYear(exp)].filter(Boolean).join(" – ");
      var msLeft = exp ? (exp.getTime() - now.getTime()) : null;
      var renewsSoon = msLeft != null ? (msLeft <= soonMs && msLeft >= 0) : false;
      var daysToRenew = msLeft != null ? Math.ceil(msLeft / (24 * 60 * 60 * 1000)) : null;
      // Bindly hasn't yet exposed an authoritative policy-status field (open
      // question to their dev), so derive it from the expiration date: past
      // expiration => expired, otherwise active. Prefer Bindly's own status if
      // it ever starts sending one.
      var status = (p.status || "").toLowerCase();
      if (!status) status = (msLeft != null && msLeft < 0) ? "expired" : "active";
      return {
        type: p.label || p.lob || "Policy",
        number: p.policy_number || "",
        carrier: p.carrier || "",
        term: term,
        effective: monthYear(eff),
        expiration: monthYear(exp),
        expiresOn: isoDay(exp),
        daysToRenew: daysToRenew,
        status: status,
        renewsSoon: renewsSoon,
        coverages: coverages(p.details)
      };
    });
    return respond.json(200, { policies: policies });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
