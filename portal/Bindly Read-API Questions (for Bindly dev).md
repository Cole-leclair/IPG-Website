# Bindly Read-API — questions from IPG (client portal integration)

Hi — we're building a client portal at **ipg.team/portal** that lets our insurance
clients log in and see *their own* data, read live from Bindly. Bindly stays the system
of record; the portal never keeps a second copy of policy data.

Today we only use Bindly's **write-only lead webhook** (`bindly.to/api/webhook/leads`,
`X-API-Key` header) to forward website leads. The portal needs Bindly's **read** side,
which we assume is a different surface. Questions below — answers to 1–4 unblock the bulk
of the build; **8 and 10 are the two we most need**.

## Core read API
1. **Read endpoints.** Is there a REST API to fetch, for a given client id:
   `GET client`, `GET policies`, `GET documents`, `GET certificates`?
   What's the **base URL** and **auth scheme** (same `X-API-Key`, or OAuth/bearer)?
2. **Client identity.** What is the stable `client_id` we should store as the single link
   to a Bindly client, and how do we look it up when we onboard a client?
3. **Documents.** Can Bindly issue **short-lived signed URLs** for a document (policy PDFs,
   dec pages, ID cards, loss runs), or must we proxy/stream the bytes server-side?
4. **COI requests.** Can we **create** a certificate request via API and **read its
   status**, or does that stay a manual workflow on your side?

## Realtime
5. **Webhooks.** Can Bindly **push** events (document added, policy renewed, COI issued)
   to a portal endpoint? How are they **signed/verified**?
6. **Rate limits & environments.** What are the limits, and can we get **separate API keys
   for staging vs production**?

## Self-service certificates (add-a-holder feature)
7. **Master certificate.** Can we read a client's master COI coverage summary (for a
   staff/back-office view)?
8. **★ Issue a certificate (hard blocker).** Can Bindly **generate an ACORD 25** for a new
   holder — **name + address only, standard wording off the master COI** — via API and
   return the PDF (ideally a short-lived signed URL)? This is our only planned issuance
   path; if the API can't do it, we have to change the feature design.
9. **Holders list.** Can we **read** the holders/certs already issued against a master COI,
   and **add** a holder?

## Additional contacts
10. **★ Multiple contacts.** Does a Bindly client record support **multiple named contacts
    with custom roles** (e.g. Billing, Safety Manager) — not just one primary? Can we
    **read / add / update / remove** them via API? (If it's single-contact-only, we'll keep
    these in our own DB.)

Thanks — happy to hop on a call if that's faster than writing it all out.

---

## Follow-up (2026-07-11) — two data-consistency issues found while wiring up the real invite flow

Thanks again for shipping the read API — it's live and working. Two things we ran into
while testing real client invites that look like bugs on Bindly's side rather than ours:

11. **`type` field disagrees with the dashboard.** `GET /clients/{client_id}` returned
    `"type":"personal"` for a client whose Bindly dashboard clearly shows a **"Commercial"**
    tag next to their name (test client "Bobby Jones", `client_id`
    `a395bdd8-f43a-4cd9-9cf0-e3d3821345af`). Also, `GET /clients?q=` (the search/lookup
    endpoint) returns `type` as an **empty string** in your own example in the API doc you
    sent us — so we now only trust `type` from the full profile endpoint, but even that
    disagreed with the UI for this client. Is `type` on the read API actually meant to
    reflect personal vs. commercial, or is that classification tracked somewhere else on
    your end? We need a reliable source for this field since it decides which dashboard a
    client sees (e.g. commercial clients get a Certificates tab).
12. **New clients take ~10 minutes to show up in search.** After creating a brand-new
    client in Bindly, `GET /clients?q=<email>` doesn't find them for roughly 10 minutes,
    even though the client already exists and is visible in your dashboard immediately. Is
    the search/lookup endpoint backed by an index that updates on a delay? If so, roughly
    how long should we expect staff to wait after adding a client before they can invite
    them through our portal, and is there a faster path (e.g. querying by exact `client_id`
    instead of search) that doesn't hit that delay?

## Follow-up (2026-07-12) — Producer / CSR field

13. **★ Producer and CSR fields.** We're adding a "Your Producer" and "Your CSR" card to
    the client's Account tab, sourced from whatever assigns those roles on the client
    record in Bindly. Two things we need: (1) the **exact key name(s)** for Producer and
    CSR on `GET /clients/{client_id}` (e.g. is it `producer` / `csr`, something nested
    under a `team` or `assigned_to` object, or something else?), and (2) the **shape** of
    the value — is it just a plain name string, or an object with name/phone/email? If
    Bindly only sends a name (no direct phone/email), that's fine — we already maintain
    our own internal directory to fill in contact info by name — we just need the field
    to reliably carry the correct name as it appears in your dashboard.

## Follow-up (2026-07-13) — a policy document isn't coming back from `/documents`

14. **★ A file tagged "POLICY" never shows up via the read API.** Test client "Test
    Commercial" (`client_id` `9fe15efa-bab9-45f9-8851-2077a807aa7a`) has a real GL policy
    on file (Chubb, eff. 01/12/2026 – 01/12/2027, confirmed via `GET
    /clients/{client_id}/policies`). We uploaded "GL Policy - Test Commercial -
    Undated.pdf" to that client's file cabinet, filed under "03 - POLICIES" and tagged
    **POLICY** in your dashboard. A full hour later, `GET
    /clients/{client_id}/documents` still returns only that client's Master COI — the
    policy PDF never appears (so this isn't the ~10-minute indexing delay from Q12).
    Two questions: (1) Why doesn't this file come back from `/documents` — does a
    document need something beyond the POLICY tag/folder placement (e.g. linked
    explicitly to the policy record, a specific filename format since ours says
    "Undated", or a separate "publish"/sync step) to be exposed via the read API? (2)
    Separately — is there any per-document flag to mark a file **internal-only / not
    shared with the client**? Your API doc describes `/documents` as returning "every
    file, categorized," so today we have no way to keep a specific file out of the
    portal short of not filing it under a tracked category at all — if a visibility
    toggle exists (or could be added), that's what we'd want to build against.
