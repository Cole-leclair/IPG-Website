// =====================================================================
// AUTH — turn an incoming request into a trusted caller context.
// Returns { authUserId, bindlyClientId, accountType }.
// This is the single choke point every portal function goes through.
// =====================================================================
//
// TODO(Clerk) Phase 1 — verify the Clerk session JWT:
//   1. Read the token from the Authorization: "Bearer <jwt>" header.
//   2. Fetch Clerk's JWKS (cache it) from CLERK_JWKS_URL and verify the
//      signature + exp + iss/aud. Use @clerk/backend or jose.
//   3. From the verified claims read:
//        sub                         -> authUserId
//        public_metadata.bindly_client_id  -> bindlyClientId
//        public_metadata.account_type      -> accountType ('personal'|'commercial')
//   4. (Optional) look the user up in portal_users to confirm status='active'.
//   NEVER trust a client id sent in the request body/query — only the JWT.
//
// Until Clerk is wired, this stays unconfigured and returns 501, EXCEPT when
// PORTAL_DEV_BYPASS=1 is set (local dev only) — then it reads throwaway
// x-dev-client / x-dev-type headers so the data path can be exercised.

function AuthError(status, message) {
  var e = new Error(message);
  e.status = status;
  return e;
}

async function verifyRequest(event) {
  // Local development escape hatch — never enable in production. CONTEXT is
  // set by Netlify ('production' | 'deploy-preview' | 'branch-deploy' | 'dev'),
  // so even a mistakenly-set env var can't open a production deploy.
  if (process.env.PORTAL_DEV_BYPASS === "1" && process.env.CONTEXT !== "production") {
    var h = event.headers || {};
    var type = h["x-dev-type"] === "commercial" ? "commercial" : "personal";
    return {
      authUserId: h["x-dev-user"] || "dev-user",
      bindlyClientId: h["x-dev-client"] || "dev-client",
      accountType: type
    };
  }

  // TODO(Clerk): replace this block with real JWT verification.
  if (!process.env.CLERK_JWKS_URL) {
    throw AuthError(501, "auth not configured — set CLERK_JWKS_URL (see utils/auth.js)");
  }

  var auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  if (!/^Bearer\s+/i.test(auth)) {
    throw AuthError(401, "missing bearer token");
  }
  // ... verify token here, then return the claims ...
  throw AuthError(501, "JWT verification not yet implemented");
}

module.exports = { verifyRequest: verifyRequest, AuthError: AuthError };
