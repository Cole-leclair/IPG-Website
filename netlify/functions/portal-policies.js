// GET /portal/policies — the signed-in client's policies (all lines of
// coverage). Maps to PortalData.getPolicies() (shape: { type, number,
// carrier, term, status, renewsSoon }).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");

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

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  try {
    var data = await bindly.getPolicies(ctx.bindlyClientId);
    var raw = (data && data.policies) || [];
    var now = new Date();
    var soonMs = 60 * 24 * 60 * 60 * 1000; // "renewing soon" = within 60 days

    var policies = raw.map(function (p) {
      var eff = parseDate(p.effective);
      var exp = parseDate(p.expiration);
      var term = [monthYear(eff), monthYear(exp)].filter(Boolean).join(" – ");
      var renewsSoon = exp ? (exp.getTime() - now.getTime()) <= soonMs && exp.getTime() >= now.getTime() : false;
      return {
        type: p.label || p.lob || "Policy",
        number: p.policy_number || "",
        carrier: p.carrier || "",
        term: term,
        status: "active",
        renewsSoon: renewsSoon
      };
    });
    return respond.json(200, { policies: policies });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
