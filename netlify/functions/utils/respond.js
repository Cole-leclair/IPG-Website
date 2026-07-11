// Tiny JSON response helper shared by the portal functions.
// (Files under utils/ are NOT deployed as their own endpoints — Netlify only
//  treats a subdirectory as a function when it contains a same-named entry
//  file. esbuild bundles these into each function that requires them.)

function json(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

module.exports = { json: json };
