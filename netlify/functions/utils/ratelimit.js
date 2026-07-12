// =====================================================================
// RATE LIMIT — lightweight, zero-dependency request throttling for the
// portal functions. Defense-in-depth against a single caller hammering an
// endpoint: repeatedly issuing certificates, scripting the contact CRUD, or
// abusing a stolen-but-still-valid session token.
//
// SCOPE / HONESTY: Netlify Functions are serverless. This limiter keeps its
// counters in the memory of ONE warm function instance, so it enforces a
// per-instance, best-effort limit that resets on a cold start. It reliably
// stops a client that reuses a warm instance (the common case) and bounds
// worst-case throughput to (live instances x limit) — it is NOT a hard
// global limit. When a strict global limit is needed, back check() with a
// shared store (Netlify Blobs or the portal Postgres) WITHOUT touching the
// call sites — the same "swaps to a DB later" pattern as utils/audit.js.
//
// NOTE ON LOGIN: password attempts go straight to Clerk, not through these
// functions, so credential-stuffing throttling is Clerk's job (Configure ->
// Protect -> Attack protection / Client Trust). This limiter protects the
// DATA endpoints that sit behind a verified session.
// =====================================================================

var WINDOW_MS = 60 * 1000;   // fixed one-minute window
var MAX_KEYS = 10000;        // safety cap on the in-memory map

var buckets = new Map();     // key -> { count, resetAt }

// Count one request against `key`. Returns
// { ok, limit, remaining, retryAfter } — retryAfter is seconds until reset.
function check(key, limit, windowMs) {
  windowMs = windowMs || WINDOW_MS;
  var now = Date.now();
  var b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;

  // Opportunistic cleanup so a long-lived warm instance can't leak memory.
  if (buckets.size > MAX_KEYS) {
    buckets.forEach(function (v, k) { if (now >= v.resetAt) buckets.delete(k); });
  }

  return {
    ok: b.count <= limit,
    limit: limit,
    remaining: Math.max(0, limit - b.count),
    retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000))
  };
}

// Best available stable identifier for the caller: the verified user id when
// we have one, otherwise the client IP Netlify puts on the request. Falls back
// to a constant only if neither exists (all such callers share one bucket).
function callerKey(event, ctx) {
  if (ctx && ctx.authUserId) return "u:" + ctx.authUserId;
  var h = (event && event.headers) || {};
  var ip = h["x-nf-client-connection-ip"] ||
           (h["x-forwarded-for"] || "").split(",")[0].trim() ||
           h["client-ip"] || "";
  return "ip:" + (ip || "unknown");
}

// One-liner guard for handlers. Returns a ready-to-return 429 response object
// when the caller is over the limit for this scope, or null when the request
// may proceed. `opts`:
//   scope    (string) keeps each endpoint's counters separate — required
//   limit    (number) max requests per window (default 60)
//   windowMs (number) window length (default 60s)
//   event, ctx        used to derive the caller key
function guard(opts) {
  opts = opts || {};

  // Local-dev escape hatch — mirrors utils/auth.js. Never active on a
  // production deploy (checks Netlify's CONTEXT), so real traffic is always
  // limited; this only keeps `netlify dev` test harnesses unthrottled.
  if (process.env.PORTAL_DEV_BYPASS === "1" && process.env.CONTEXT !== "production") {
    return null;
  }

  var key = (opts.scope || "global") + "|" + callerKey(opts.event, opts.ctx);
  var r = check(key, opts.limit || 60, opts.windowMs);
  if (r.ok) return null;

  return {
    statusCode: 429,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": String(r.retryAfter)
    },
    body: JSON.stringify({ error: "Too many requests — please wait a moment and try again." })
  };
}

module.exports = { guard: guard, check: check, callerKey: callerKey };
