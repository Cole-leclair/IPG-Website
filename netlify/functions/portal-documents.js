// GET /portal/documents            -> document metadata list
// GET /portal/documents?id=<docId> -> short-lived signed download URL
// Maps to PortalData.getDocuments() in portal.js.
var auth = require("./utils/auth");
var bindly = require("./utils/bindly");
var respond = require("./utils/respond");
var audit = require("./utils/audit");

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var ctx;
  try { ctx = await auth.verifyRequest(event); }
  catch (e) { return respond.json(e.status || 401, { error: e.message }); }

  var docId = event.queryStringParameters && event.queryStringParameters.id;

  try {
    if (docId) {
      // TODO(Bindly): const { url } = await bindly.getDocumentUrl(ctx.bindlyClientId, docId);
      // Return a SHORT-LIVED signed URL only — never a permanent/public link.
      audit.log({ action: "download_document", actor: ctx.authUserId, bindlyClientId: ctx.bindlyClientId, target: docId });
      return respond.json(200, { url: null }); // stub
    }
    // TODO(Bindly): const documents = await bindly.getDocuments(ctx.bindlyClientId);
    // Shape each as { id, name, kind, date }.
    var documents = []; // stub
    return respond.json(200, { documents: documents });
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
