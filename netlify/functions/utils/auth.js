// =====================================================================
// AUTH — turn an incoming request into a trusted caller context.
// Returns { authUserId, bindlyClientId, accountType }.
// This is the single choke point every portal function goes through.
// =====================================================================
//
// Verifies a Clerk session JWT with NO npm dependencies — Node's built-in
// `crypto` verifies the RS256 signature against Clerk's JWKS. (Netlify runs
// Node 18+, which has global `fetch` and JWK key import.)
//
// The caller's Bindly client id + account type are read from the VERIFIED
// token claims — never from anything the browser sends. For those claims to
// exist, add them to Clerk's session token (Configure -> Sessions ->
// customize session token):
//   { "bindly_client_id": "{{user.public_metadata.bindly_client_id}}",
//     "account_type":     "{{user.public_metadata.account_type}}",
//     "role":             "{{user.public_metadata.role}}" }
// (role gates the staff/admin tab — see verifyStaff below.)
//
// Until CLERK_JWKS_URL is set this returns 501, EXCEPT when PORTAL_DEV_BYPASS=1
// (local dev only) — then it reads throwaway x-dev-* headers so the data path
// can be exercised without Clerk.

var crypto = require("crypto");

function AuthError(status, message) {
  var e = new Error(message);
  e.status = status;
  return e;
}

// ---- JWKS cache (Clerk rotates keys rarely; cache for an hour) ----
var JWKS_TTL_MS = 60 * 60 * 1000;
var _jwks = { keys: null, fetchedAt: 0 };

async function fetchJwks() {
  var url = process.env.CLERK_JWKS_URL;
  var res = await fetch(url);
  if (!res.ok) throw AuthError(500, "could not fetch JWKS (" + res.status + ")");
  var body = await res.json();
  _jwks.keys = (body && body.keys) || [];
  _jwks.fetchedAt = Date.now();
}

async function getSigningKey(kid) {
  var fresh = _jwks.keys && (Date.now() - _jwks.fetchedAt) < JWKS_TTL_MS;
  if (!fresh) await fetchJwks();
  var jwk = _jwks.keys.filter(function (k) { return k.kid === kid; })[0];
  if (!jwk) {
    // Unknown kid — maybe a rotation happened; refresh once and retry.
    await fetchJwks();
    jwk = _jwks.keys.filter(function (k) { return k.kid === kid; })[0];
  }
  return jwk || null;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function verifyJwt(token) {
  var parts = String(token).split(".");
  if (parts.length !== 3) throw AuthError(401, "malformed token");

  var header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
  } catch (e) {
    throw AuthError(401, "unparseable token");
  }
  if (header.alg !== "RS256") throw AuthError(401, "unexpected token algorithm");

  var jwk = await getSigningKey(header.kid);
  if (!jwk) throw AuthError(401, "unknown signing key");

  var pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  var signingInput = Buffer.from(parts[0] + "." + parts[1]);
  var ok = crypto.verify("RSA-SHA256", signingInput, pubKey, b64urlToBuf(parts[2]));
  if (!ok) throw AuthError(401, "bad token signature");

  // Time checks with a small clock-skew allowance.
  var now = Math.floor(Date.now() / 1000);
  var skew = 5;
  if (payload.exp && now > payload.exp + skew) throw AuthError(401, "token expired");
  if (payload.nbf && now < payload.nbf - skew) throw AuthError(401, "token not yet valid");

  // Optional issuer pinning (set CLERK_ISSUER to the Clerk Frontend API URL,
  // e.g. https://exciting-oyster-75.clerk.accounts.dev).
  if (process.env.CLERK_ISSUER && payload.iss !== process.env.CLERK_ISSUER) {
    throw AuthError(401, "unexpected token issuer");
  }
  return payload;
}

async function verifyRequest(event) {
  // Local development escape hatch — never enable in production. CONTEXT is
  // set by Netlify ('production' | 'deploy-preview' | 'branch-deploy' | 'dev'),
  // so even a mistakenly-set env var can't open a production deploy.
  if (process.env.PORTAL_DEV_BYPASS === "1" && process.env.CONTEXT !== "production") {
    var h = event.headers || {};
    var t = h["x-dev-type"] === "commercial" ? "commercial" : "personal";
    return {
      authUserId: h["x-dev-user"] || "dev-user",
      bindlyClientId: h["x-dev-client"] || "dev-client",
      accountType: t,
      role: h["x-dev-role"] || "client"
    };
  }

  if (!process.env.CLERK_JWKS_URL) {
    throw AuthError(501, "auth not configured — set CLERK_JWKS_URL (see utils/auth.js)");
  }

  var authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  if (!/^Bearer\s+/i.test(authHeader)) throw AuthError(401, "missing bearer token");
  var token = authHeader.replace(/^Bearer\s+/i, "").trim();

  var claims = await verifyJwt(token);

  // Read the Bindly link + type from the verified claims. Support either a
  // flat custom claim (recommended session-token shape) or a nested
  // public_metadata object, whichever the Clerk session token carries.
  var meta = claims.public_metadata || claims.publicMetadata || {};
  var bindlyClientId = claims.bindly_client_id || meta.bindly_client_id;
  var accountType = claims.account_type || meta.account_type;
  var role = claims.role || meta.role || "client";

  if (!bindlyClientId) {
    throw AuthError(403, "no bindly_client_id in token — add it to the Clerk session token claims");
  }
  return {
    authUserId: claims.sub,
    bindlyClientId: bindlyClientId,
    accountType: accountType === "commercial" ? "commercial" : "personal",
    role: role
  };
}

// Staff/admin gate for the admin tab (portal-admin-users.js). Unlike a client,
// a staff member has NO bindly_client_id — they aren't a client — so this does
// NOT require one. It requires role ∈ {staff, admin}, read from the VERIFIED
// token (the Clerk session token must carry a `role` claim, see the header).
async function verifyStaff(event) {
  // Local dev escape hatch — defaults to admin so the tab is testable without
  // Clerk. Never active on a production deploy (checks Netlify's CONTEXT).
  if (process.env.PORTAL_DEV_BYPASS === "1" && process.env.CONTEXT !== "production") {
    var h = event.headers || {};
    var devRole = h["x-dev-role"] === "staff" ? "staff" : "admin";
    return { authUserId: h["x-dev-user"] || "dev-staff", role: devRole, email: h["x-dev-email"] || "" };
  }

  if (!process.env.CLERK_JWKS_URL) {
    throw AuthError(501, "auth not configured — set CLERK_JWKS_URL (see utils/auth.js)");
  }

  var authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  if (!/^Bearer\s+/i.test(authHeader)) throw AuthError(401, "missing bearer token");
  var token = authHeader.replace(/^Bearer\s+/i, "").trim();

  var claims = await verifyJwt(token);
  var meta = claims.public_metadata || claims.publicMetadata || {};
  var role = claims.role || meta.role || "client";
  if (role !== "staff" && role !== "admin") throw AuthError(403, "staff access required");

  return { authUserId: claims.sub, role: role, email: claims.email || meta.email || "" };
}

module.exports = { verifyRequest: verifyRequest, verifyStaff: verifyStaff, AuthError: AuthError };
