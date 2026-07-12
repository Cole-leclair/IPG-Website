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
