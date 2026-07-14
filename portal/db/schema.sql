-- =====================================================================
-- IPG Client Portal — database schema (Postgres / Neon)
-- =====================================================================
-- This is the data the portal OWNS. It is NOT a copy of Bindly.
--   * Identity (emails, passwords, MFA, sessions) lives in CLERK.
--   * Clients, policies, documents, certificates live in BINDLY.
--   * This DB only holds: the user<->Bindly-client link, invitations,
--     certificate holders, additional contacts, and the audit trail.
-- See portal/ARCHITECTURE.md §3 for the full rationale.
--
-- HOW TO RUN: paste this whole file into the Neon dashboard SQL Editor
-- and run it. It is safe to re-run — every statement is idempotent.
-- =====================================================================

-- gen_random_uuid() lives in pgcrypto (built into Neon).
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- portal_users — one row per portal login. Links a Clerk identity to a
-- Bindly client. This is the source of truth for "who is allowed in".
-- ---------------------------------------------------------------------
create table if not exists portal_users (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      text unique,                      -- Clerk user id (null until invite accepted)
  bindly_client_id  text not null,                    -- the single link to Bindly
  account_type      text not null check (account_type in ('personal','commercial')),
  role              text not null default 'client' check (role in ('client','staff','admin')),
  email             text not null,
  status            text not null default 'invited' check (status in ('invited','active','disabled')),
  created_at        timestamptz not null default now(),
  last_login_at     timestamptz
);
create index if not exists portal_users_bindly_client_idx on portal_users (bindly_client_id);
create index if not exists portal_users_email_idx on portal_users (lower(email));

-- ---------------------------------------------------------------------
-- invitations — invite-only onboarding. Staff create these; there is no
-- open signup. Store a HASH of the token, never the raw token.
-- ---------------------------------------------------------------------
create table if not exists invitations (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  bindly_client_id  text not null,
  account_type      text not null check (account_type in ('personal','commercial')),
  token_hash        text not null,
  expires_at        timestamptz not null,
  invited_by        text,                              -- staff/admin id
  accepted_at       timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists invitations_email_idx on invitations (lower(email));

-- ---------------------------------------------------------------------
-- cert_holders — was unused after the 2026-07-10 simplification (client
-- self-service certs are instant, no rows written here). Repurposed
-- 2026-07-14 to track description-of-operations COI requests, which DO
-- need a review step: a row here is the record of a pending Bindly
-- coi-request ticket until a matching real certificate shows up in
-- Bindly's own certificates list (see portal-cert-holders.js).
-- ---------------------------------------------------------------------
create table if not exists cert_holders (
  id                         uuid primary key default gen_random_uuid(),
  portal_user_id             uuid references portal_users(id) on delete set null,
  bindly_client_id           text not null,
  holder_name                text not null,
  holder_address             text,
  status                     text not null default 'pending' check (status in ('pending','resolved')),
  bindly_cert_id             text,                       -- unused (kept for compat)
  issued_doc_ref             text,                       -- unused (kept for compat)
  bindly_request_id          text unique,                -- Bindly's coi-request ticket id
  description_of_operations  text,                       -- what the client entered, for our own record
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz
);
create index if not exists cert_holders_client_idx on cert_holders (bindly_client_id);
alter table cert_holders add column if not exists bindly_request_id text unique;
alter table cert_holders add column if not exists description_of_operations text;

-- ---------------------------------------------------------------------
-- portal_contacts — additional reference contacts (billing/safety/etc.)
-- for an account. NOT portal logins. INTERIM table: migrates into Bindly
-- once the Bindly API supports multiple named contacts (ARCHITECTURE §9 q10).
-- ---------------------------------------------------------------------
create table if not exists portal_contacts (
  id                uuid primary key default gen_random_uuid(),
  bindly_client_id  text not null,
  name              text not null,
  role              text,                               -- free text, e.g. "Billing", "Safety Manager"
  email             text,
  phone             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
create index if not exists portal_contacts_client_idx on portal_contacts (bindly_client_id);

-- ---------------------------------------------------------------------
-- staff_directory — phone/email for whoever Bindly names as a client's
-- Producer or CSR (netlify/functions/portal-me.js). Self-service: each
-- staff/admin login updates their own row via portal-staff-profile.js.
-- Keyed by the lowercased display name (name_key) since that's the only
-- thing Bindly's producer/csr fields give us to join on — there's no
-- Bindly-side staff id to link against a Clerk user id.
-- ---------------------------------------------------------------------
create table if not exists staff_directory (
  name_key          text primary key,                  -- lower(trim(name)), e.g. "cole leclair"
  name              text not null,                      -- display name as Bindly resolves it
  phone             text,
  email             text,
  updated_by        text,                                -- Clerk user id of whoever last saved it
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- audit_log — compliance trail (GLBA Safeguards). Who viewed/downloaded
-- what. utils/audit.js writes here once wired; logs to Netlify function
-- logs until then.
-- ---------------------------------------------------------------------
create table if not exists audit_log (
  id                uuid primary key default gen_random_uuid(),
  actor             text,                               -- portal_user_id | staff | 'system'
  action            text not null,                      -- 'login'|'view_policies'|'download_document'|...
  target            text,                               -- document id, policy id, etc.
  bindly_client_id  text,
  ip                text,
  user_agent        text,
  created_at        timestamptz not null default now()
);
create index if not exists audit_log_client_idx on audit_log (bindly_client_id);
create index if not exists audit_log_created_idx on audit_log (created_at);
