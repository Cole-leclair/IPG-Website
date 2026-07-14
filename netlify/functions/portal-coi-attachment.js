// GET /portal/coi-attachment?id=<uuid> — serves a client-uploaded attachment
// for a description-of-operations COI request (see portal-coi-requests.js).
//
// Deliberately UNAUTHENTICATED: the Bindly agent working the ticket clicks
// this link from the ticket notes, and isn't signed into our portal. The
// random UUID is the only "auth" — the same security model Bindly's own
// signed document URLs already use (a long random token, no session).
var respond = require("./utils/respond");
var attachments = require("./utils/attachments");

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") return respond.json(405, { error: "method not allowed" });

  var id = (event.queryStringParameters && event.queryStringParameters.id) || "";
  if (!id) return respond.json(400, { error: "missing id" });

  try {
    var file = await attachments.get(id);
    if (!file) return respond.json(404, { error: "not found" });
    return {
      statusCode: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": "inline; filename=\"" + file.filename.replace(/"/g, "") + "\"",
        "Cache-Control": "private, max-age=3600"
      },
      body: file.buffer.toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return respond.json(e.status || 500, { error: e.message });
  }
};
