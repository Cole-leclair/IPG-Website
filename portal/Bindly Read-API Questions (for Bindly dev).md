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
