# IPG Client Portal — Backend Architecture

> Reference for wiring the portal to real data. Written for IPG + the Bindly developer.
> Status: the frontend (login toggle, dashboard, tabs, COI form) is built against a mock
> `PortalData` layer. This document describes the backend that replaces the mock.

---

## 1. Guiding principles

1. **Bindly is the system of record.** Clients, policies, documents, and issued
   certificates live in Bindly. The portal *reads through* Bindly — it never keeps a
   second master copy of policy data.
2. **We never handle passwords.** A managed auth provider (Clerk/Auth0) owns identity,
   passwords, MFA, sessions, lockout, and reset. Rolling our own auth for insurance PII
   is a liability we don't take on.
3. **The browser never sees a secret.** Every call to Bindly happens server-side in a
   Netlify Function that holds the API key (exactly the pattern already used by
   `submission-created.js`). The portal's JavaScript only talks to *our* API.
4. **The portal DB only owns what Bindly doesn't.** User↔client mapping, invitations,
   certificate-holder records, and audit logs. Not copies of policies/documents.
5. **Authorize on the server, every time.** The hidden Certificates tab is UX, not
   security. Type rules (personal vs commercial) and client-scoping are enforced in the
   functions, keyed off a verified token — never off anything the browser sends.

---

## 2. Components (the stack)

```
                          ┌───────────────────────────────────────────┐
   Browser                │                 NETLIFY                    │
 ┌──────────┐  JWT (Clerk)│  ┌─────────────────────────────────────┐   │
 │ portal.js │────────────┼─▶│  Netlify Functions  (the BFF/API)   │   │
 │  (SPA)    │◀───JSON─────┼──│  - verify JWT (Clerk JWKS)          │   │
 └────┬─────┘             │  │  - resolve caller's bindly_client_id │   │
      │ Clerk SDK          │  │  - authorize (type + client scope)  │   │
      ▼                    │  │  - call Bindly w/ server-side key   │   │
 ┌──────────┐              │  └────┬───────────────┬────────────────┘   │
 │  CLERK   │  identity     │       │               │                    │
 │ (auth)   │◀──────────────┘       │ X-API-Key     │ SQL                │
 └──────────┘               └───────┼───────────────┼────────────────────┘
                                     ▼               ▼
                            ┌────────────────┐  ┌──────────────────┐
                            │     BINDLY      │  │  PORTAL DB (PG)   │
                            │ system of record│  │ users, invites,  │
                            │ clients/policies│  │ cert_holders,    │
                            │ docs / certs    │  │ contacts, audit  │
                            └────────────────┘  └──────────────────┘
```

| Layer | Choice (recommended) | Why |
|---|---|---|
| **Frontend** | Existing static site + `portal.js` | Already built. Talks only to our functions. |
| **Auth** | **Clerk** (Auth0 = enterprise alt) | Invite-only signup, MFA, password reset, sessions, bot protection out of the box. Cheap + fast for a small team. Easy JWT verification in serverless. |
| **API layer** | **Netlify Functions** | Already in use (`submission-created.js`, `reviews.js`). Holds secrets in env vars. Backend-for-frontend that fronts Bindly. |
| **Portal DB** | **Neon** or **Supabase** (Postgres) | Serverless Postgres for the data Bindly doesn't own. Neon = leanest (scales to zero). Supabase if you also want file storage + a dashboard + row-level security. |
| **System of record** | **Bindly** | Clients, policies, documents, certificates. Read-only from the portal's perspective. |
| **Transactional email** | **Postmark** (or SendGrid) | Invite emails, "your COI is ready" notices. Better deliverability than ad-hoc SMTP. |

**Vendor-count tradeoff:** you *can* collapse Clerk + Neon into **Supabase alone**
(Supabase does Postgres + Auth + Storage + RLS). Fewer vendors, one bill. The cost is
Supabase Auth's MFA/enterprise story is less polished than Clerk's. For an insurance
portal where clients download sensitive docs, my recommendation is **Clerk for auth +
Neon/Supabase for the DB** — but all-Supabase is a defensible, cheaper starting point.

---

## 3. Data model — who stores what

### In Clerk (identity — managed for us)
- User: id, email, password, MFA factors, sessions.
- Custom metadata on the user:
  - `bindly_client_id` — the single link to Bindly.
  - `account_type` — `personal` | `commercial`.
  - `role` — `client` | `staff` | `admin`.

### In Bindly (system of record — we do NOT duplicate)
- Client / account (personal or commercial), contacts
- Policies (type, number, carrier, term, status)
- Documents (policy PDFs, dec pages, ID cards, loss runs)
- Certificates (issued COIs)

### In the Portal DB (Postgres — what we own)

```sql
-- Links a Clerk identity to a Bindly client. One row per portal login.
portal_users (
  id             uuid primary key,
  auth_user_id   text unique,          -- Clerk user id
  bindly_client_id text not null,      -- the link to Bindly
  account_type   text not null,        -- 'personal' | 'commercial'
  email          text not null,
  status         text not null,        -- 'invited' | 'active' | 'disabled'
  created_at     timestamptz default now(),
  last_login_at  timestamptz
)

-- Invite-only onboarding. IPG staff create these; no open signup.
invitations (
  id             uuid primary key,
  email          text not null,
  bindly_client_id text not null,
  account_type   text not null,
  token_hash     text not null,        -- store a HASH, never the raw token
  expires_at     timestamptz not null,
  invited_by     text,                 -- staff id
  accepted_at    timestamptz
)

-- Certificate holders on a client's master COI. Commercial only.
-- Simplified 2026-07-10: client only supplies name/address, always instant
-- issue — no wording/review columns needed anymore.
cert_holders (
  id               uuid primary key,
  portal_user_id   uuid references portal_users(id),
  bindly_client_id text not null,
  holder_name      text not null,
  holder_address   text,
  status           text not null,      -- 'issued' (only status today; kept for future use)
  bindly_cert_id   text,               -- issued cert id in Bindly
  issued_doc_ref   text,               -- link/handle to the ACORD 25 in Bindly
  created_at       timestamptz default now(),
  updated_at       timestamptz
)

-- Additional reference contacts (billing/safety/etc.) for an account — NOT
-- portal logins. INTERIM table: Bindly's client model likely only tracks one
-- primary contact, not an arbitrary list with custom roles, so these live
-- here for now. Cole wants these to eventually feed into Bindly instead —
-- once the Bindly developer confirms their API can read/write additional
-- contacts on a client record, migrate this data into Bindly and retire this
-- table (see utils/bindly.js TODOs + portal-contacts.js).
portal_contacts (
  id               uuid primary key,
  bindly_client_id text not null,
  name             text not null,
  role             text,               -- free text, e.g. "Billing", "Safety Manager"
  email            text,
  phone            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz
)

-- Compliance trail: who viewed / downloaded what. (GLBA safeguards.)
audit_log (
  id               uuid primary key,
  actor            text,               -- portal_user_id | staff | 'system'
  action           text,               -- 'login'|'view_policies'|'download_document'|...
  target           text,               -- document id, policy id, etc.
  bindly_client_id text,
  ip               text,
  user_agent       text,
  created_at       timestamptz default now()
)
```

Optional as you grow: `notifications` (in-portal), and a short-TTL `cache`
(or Netlify Blobs) for Bindly responses.

---

## 4. Login & onboarding flow (invite-only)

```
Staff creates account ──▶ invitations row (email + bindly_client_id + type)
                          + Clerk invite email sent
        │
Client clicks link ──────▶ sets password in Clerk (MFA optional/required)
        │                  Clerk user created; metadata = {bindly_client_id, type}
        │                  portal_users row flipped to 'active'
        ▼
Client logs in ──────────▶ Clerk issues short-lived JWT (+ refresh)
        │
Every API call ──────────▶ Function verifies JWT signature against Clerk JWKS
                          → reads bindly_client_id + account_type from claims
                          → authorizes → calls Bindly scoped to THAT client
```

- **No open registration.** Accounts are provisioned by IPG (matches the login card copy:
  "Accounts are set up by IPG").
- Password reset, MFA, and account lockout are all Clerk's job.
- **The client never chooses their account type.** `account_type` (personal vs
  commercial) comes from Clerk metadata / the `portal_users` row, sourced from the Bindly
  client record. The login form asks only for email + password. (In PREVIEW MODE the
  login form is hidden entirely — the card shows explicit "View demo" buttons instead,
  so nobody types real credentials into a mock form. `?demo=commercial` /
  `?demo=personal` deep links still work. None of this exists once Clerk is live.)

---

## 5. API endpoints (Netlify Functions)

All under `/.netlify/functions/` (optionally aliased to `/api/*` via redirects). Every
read: **authenticate → resolve client → authorize → proxy to Bindly**.

| Method + path | Purpose | Notes |
|---|---|---|
| `GET /portal/me` | Profile + account_type | From Clerk/portal DB, light Bindly enrich |
| `GET /portal/policies` | Client's policies | Bindly read, scoped to caller |
| `GET /portal/documents` | Document metadata list | Bindly read |
| `GET /portal/documents/:id/url` | Short-lived signed download URL | Authz'd; no permanent URLs |
| `GET /portal/cert-holders` | Holders/certs on the master COI | **Commercial only** |
| `POST /portal/cert-holders` | Add a holder (self-service, always instant issue) | **Commercial only.** Name/address only — no review path |
| `GET /portal/contacts` | List additional reference contacts | Portal DB today (see §3); migrates to Bindly later |
| `POST /portal/contacts` | Add a reference contact | " |
| `PUT /portal/contacts?id=` | Update a reference contact | " |
| `DELETE /portal/contacts?id=` | Remove a reference contact | " |
| `POST /webhooks/bindly` | Inbound Bindly updates | Verify signature; invalidate cache / notify |
| `POST /submission-created` | Lead forwarding (existing) | Unchanged |

These map 1:1 onto the mock `PortalData` methods already in `portal.js`, so wiring is a
matter of swapping each mock body for a `fetch()` to the matching endpoint — the UI
doesn't change.

### 5a. Self-service certificates (the master COI + add-holder flow)

**Simplified 2026-07-10** — commercial clients issue their own COIs by adding a
**holder** (name + address only) to their **master certificate**. There is no
wording/endorsement picker and no review-routing path in the UI anymore — every
holder request is standard coverage off the master template and **always issues
instantly** (`portal-cert-holders.js` always returns `status: "issued"`).

Because the client can never request non-standard wording, there's nothing for
the server to gate — the E&O guardrail *is* the absence of a free-text/wording
field on the form. If IPG later wants to support special wording again, that
would need to come back as a review-routed path (staff-only), not client
self-service.

---

## 6. Documents — safe delivery

Documents are sensitive. Never expose a permanent or public URL.

1. Portal asks `GET /portal/documents/:id/url`.
2. Function verifies the caller owns that document's client, then asks Bindly for a
   **short-lived signed URL** (minutes-long expiry).
3. If Bindly can't sign URLs, the function streams the file itself after the authz check
   (never a public bucket).
4. Log the download in `audit_log`.

---

## 7. Security & compliance (insurance = PII + financial data)

- **Secrets** live only in Netlify env vars; browser never holds the Bindly key. Separate
  keys per environment; least-privilege; rotate periodically.
- **JWT verified on every function** against Clerk's JWKS. Authorize by the
  `bindly_client_id` *in the verified token* — never trust a client-supplied id.
- **Server-side type enforcement.** `certificates` and COI `requests` return 403 for
  personal accounts regardless of what the frontend shows.
- **MFA** available (recommend required) for accounts that download policy documents.
- **Audit log** for logins, views, and downloads → maps to GLBA Safeguards Rule
  expectations for a financial/insurance institution. (`utils/audit.js` exists and is
  called from the functions today — it logs structured JSON to the Netlify function
  logs until the `audit_log` table lands.)
- **Signed, short-TTL document URLs**; no public storage.
- **Rate limiting** on functions (esp. login-adjacent + document endpoints).
- **PII minimization:** the portal DB stores *references* (`bindly_client_id`, doc ids),
  not copies of policy data.
- **Environments:** separate dev / staging / prod, each with its own Bindly key + Clerk
  instance + database.
- **TLS + HSTS** everywhere (HSTS + nosniff + frame/referrer/permissions headers are
  configured site-wide in `netlify.toml`).

---

## 8. Phased roadmap

| Phase | Scope | Blocked on |
|---|---|---|
| **0 — Done** | Static portal + mock `PortalData`, personal/commercial split | — |
| **1 — Auth (scaffolded)** | Function stubs + `utils/auth.js`, `utils/bindly.js` in place; `PORTAL_CONFIG` seam in `portal.js`. Remaining: Clerk account + keys, invite-only flow, `portal_users` + `invitations` tables, swap mock login for Clerk session. | Clerk account |
| **2 — Bindly reads** | `me` / `policies` / `documents` / `certificates` functions; point `PortalData` getters at them; signed doc URLs | **Bindly read API details** |
| **3 — Certificates** | `cert_holders` table; wire instant ACORD 25 issuance via Bindly (§5a); notify IPG on issue | Bindly COI generate API (§9 q8) |
| **4 — Realtime** | Bindly webhooks, notifications, response caching, audit hardening | Bindly webhook support |
| **5 — Launch polish** | Remove preview banner + login toggle, enforce MFA, monitoring, retention policy | — |

---

## 9. The one thing that unblocks everything: Bindly's read API

The current integration (`submission-created.js`) uses a **write-only lead webhook**
(`bindly.to/api/webhook/leads`, `X-API-Key` header). The portal needs Bindly's **read**
side, which is almost certainly a different surface. Ask the Bindly developer:

1. **Read endpoints** — is there a REST API to fetch, for a given client id:
   `GET client`, `GET policies`, `GET documents`, `GET certificates`? Base URL + auth scheme?
2. **Client identity** — what is the stable `client_id` we store as `bindly_client_id`,
   and how do we look it up when onboarding a client?
3. **Documents** — can Bindly issue **short-lived signed URLs** for a document, or must we
   proxy/stream the bytes?
4. **COI requests** — can we **create** a certificate request via API and **read its
   status**, or does that stay a manual IPG workflow (portal DB tracks it, humans fulfill)?
5. **Webhooks** — can Bindly **push** events (document added, policy renewed, COI issued)
   to a portal endpoint, and how are they signed/verified?
6. **Rate limits & environments** — limits, and whether we can get **separate keys** for
   staging vs production.

**Self-service certificates (the add-holder feature) needs these too:**

7. **Master certificate** — can we read a client's master COI coverage summary (the
   read-only display was pulled from the portal UI 2026-07-11, but IPG staff/back-office
   may still want this)?
8. **Issue a certificate** — can Bindly **generate an ACORD 25** for a new holder
   (name/address only, standard wording) from the master COI via API and return the PDF
   (ideally a short-lived signed URL)? **This is now the only issuance path** — the portal
   no longer has a review-routing fallback in the UI, so if Bindly can't do this via API,
   IPG needs to decide: (a) build a review-routed path back into the UI, or (b) fall back
   to the internal ACORD 25 pipeline (see the coi-creator skill) triggered some other way,
   or (c) hold this feature until Bindly can do it.
9. **Holders list** — can we read the holders/certs already issued against a master COI,
   and add a holder?

**Additional contacts (billing/safety/etc.) — Cole wants these to eventually live in
Bindly instead of our own DB:**

10. **Contact read/write** — does Bindly's client record support **multiple** named
    contacts with custom roles (not just one primary contact)? Can we **read**, **add**,
    **update**, and **remove** them via API? If Bindly's model is single-contact-only,
    these stay in our own `portal_contacts` table indefinitely (see §3).

Answers to 1–4 determine Phases 2–3; 5 determines Phase 4; **8 is now a hard blocker for
the add-holder feature specifically** — there's no review fallback to lean on anymore.
**10 determines whether `portal-contacts.js` stays on our DB or migrates to Bindly** —
either way the frontend (`portal.js`) doesn't change, only the function bodies do.
