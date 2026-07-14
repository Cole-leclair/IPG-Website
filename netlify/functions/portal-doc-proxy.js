// GET /portal/doc-proxy?doc=master-coi — streams a PDF from Bindly through
// OUR origin instead of handing back Bindly's own signed URL. Needed ONLY so
// the browser can preview it in an in-page <iframe>: Bindly's doc responses
// carry `X-Frame-Options: SAMEORIGIN`, so embedding their URL directly is
// blocked by the browser. Regular downloads (documents, cert holders) still
// go straight from Bindly to the browser as before — this proxy is only for
// the "Preview" affordance, and only for documents this exact endpoint
// resolves itself (never an arbitrary URL the client passes in).
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var ratelimit = require("./utils/ratelimit");
var audit = require("./utils/audit");

// Resolves the signed Bindly URL for a known, named document — add a case
// here for each thing worth in-page-previewing. Never accepts a raw URL
// from the caller.
async function resolveDocUrl(doc, bindlyClientId) {
  if (doc === "master-coi") {
    var data = await bindly.getClient(bindlyClientId);
    var c = (data && data.client) || data || {};
    var mc = c.master_coi;
    return (mc && mc.approved && mc.url) || null;
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var limited = ratelimit.guard({ scope: "portal-doc-proxy", limit: 30, event: event, ctx: ctx });
  if (limited) return limited;

  var doc = (event.queryStringParameters && event.queryStringParameters.doc) || "";

  try {
    var url = await resolveDocUrl(doc, ctx.bindlyClientId);
    if (!url) return respond.json(404, { error: "nothing to preview" });

    var upstream;
    try {
      upstream = await fetch(url);
    } catch (netErr) {
      return respond.json(502, { error: "couldn’t reach the document" });
    }
    if (!upstream.ok) return respond.json(502, { error: "couldn’t load the document" });

    var buf = Buffer.from(await upstream.arrayBuffer());
    await audit.log({ action: "preview_document", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: doc, event: event });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "no-store"
        // Deliberately NOT setting X-Frame-Options — this response is same-
        // origin (ipg.team), so the portal's own <iframe> can embed it.
      },
      body: buf.toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
