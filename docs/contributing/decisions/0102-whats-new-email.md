# 0102: Newsletter consent is user-owned; newsletter delivery has its own sender

- **Status:** accepted
- **Date:** 2026-11-14

## Decision

Store What's New in Kody consent on `users`, default off. A null choice
timestamp means never chosen; off with a timestamp means explicitly
unsubscribed. Password signup offers an unchecked checkbox. OAuth signup stays
off. Account exports include all consent fields. Consent also records its
source: `signup`, `settings`, `email_link`, or `admin`, null before a choice.
The admin setter defaults to `admin` and permits `email_link` for package-owned
signed links. No existing account notification preferences area exists, so no
settings toggle is added here.

Only Kody site admins can list verified live users' emails, change consent, or
send newsletter mail. Packages must declare the admin capabilities and act with
an admin's authority; being published by an admin is not itself a grant.
Existing package-app authorization remains unchanged. Hosted execute preserves
its caller's authority, not the package publisher's. Package apps currently omit
site roles from their runs-as caller and do not defer site access to the actor,
so even an admin publisher's anonymous app cannot call these capabilities. Org
admin is not Kody site admin. Supporting that app workflow requires a separate
auth decision.

Send newsletters through Kody's Cloudflare Email integration as `news@`, named
Kent from Kody, with replies to `kent@`. Reserve the local for inbound system
mail. One recipient per call, a distinct `whats_new` delivery kind, and a
separate daily send counter (`systemEmailLimits.maxNewsletterSendsPerDay`)
isolate newsletter volume and sender complaints from transactional
correspondence. Shared recipient suppression still applies.
`adminSystemEmailSend` cannot select `news`.

Cloudflare reports match `system_email_sends` by provider message ID and
recipient. The delivery listing exposes the latest matched status per newsletter
send, not a complete event history; system send records expire after 90 days.
Its cursor orders status timestamp and the composite send key. Status updates
can move a send during pagination. No new delivery pipeline is introduced. The
returned send ID encodes the existing composite key as JSON, or is null when the
provider returned no message ID and matching is unavailable.

Cloudflare Email has no idempotency key or send lookup, so a caller that loses
the response cannot tell whether a newsletter went out. `adminWhatsNewEmailSend`
takes an optional `idempotency_key`, stable per campaign and recipient, stored
in `system_email_send_keys` per send kind. Kody reserves the key before the
daily counter or Cloudflare is touched. A retry of a sent key returns the stored
result with `replayed: true` and sends nothing. A key refused before Cloudflare
accepted anything (suppression, daily limit, a 4xx rejection) may be retried. A
key still pending, or whose provider call was lost in transport or answered 5xx,
is refused as outcome unknown and never retried automatically, because the
message may already have been delivered. Keys expire with the 90-day send
retention.

The package owns composition, audience selection, consent checks before sending,
and signed opt-in/out links and public pages. No platform unsubscribe-token API
or general bulk-mail primitive is introduced.

## Public sign-up (2026-11-15)

`/newsletter` lets anyone ask for the newsletter without an account. The site
owns it because consent and the `news@` sender live here and an anonymous
package app cannot send. A request is a pending `newsletter_signups` row and one
confirmation email (`whats_new_confirm` kind). The emailed link opens a page
whose button posts the single-use, 7-day token; only that POST confirms, so link
scanners cannot subscribe anyone. Tokens are stored hashed.

A confirmed address with no verified account is a recipient under its own 64-hex
`stable_id`, with source `newsletter_page`. A verified account with the same
address is opted in instead (stored as `email_link`, reported as
`newsletter_page` while that confirmation is its latest choice). Pending rows
are never recipients and the admin setter cannot switch them on. Bot protection
is a honeypot, per-IP and per-address rate limits, and Turnstile, verified with
siteverify before any row or email is created. The form therefore needs
JavaScript; without it a note replaces the fields. Responses do not reveal
whether an address is already subscribed.

Consent moves between the site and the newsletter package at the moment it
changes, not on a schedule. Site changes (a confirmed sign-up, a verified
account's sign-up choice, an admin change) go out as the admin-only
`whats_new.consent.changed` event from a `whats_new_consent_outbox` row, so a
failed delivery is retried and never blocks the confirm. The package writes its
own opt-ins and unsubscribes back with `adminWhatsNewOptInSet` (source
`email_link`), which is not echoed. See
[admin events](../../guides/admin-events.md).
