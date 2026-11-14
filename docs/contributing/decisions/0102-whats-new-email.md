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
separate 2,000-send daily counter isolate newsletter volume and sender
complaints from transactional correspondence. Shared recipient suppression still
applies. `adminSystemEmailSend` cannot select `news`.

Cloudflare reports match `system_email_sends` by provider message ID and
recipient. The delivery listing exposes the latest matched status per newsletter
send, not a complete event history; system send records expire after 90 days.
Its cursor orders status timestamp and the composite send key. Status updates
can move a send during pagination. No new delivery pipeline is introduced. The
returned send ID encodes the existing composite key as JSON, or is null when the
provider returned no message ID and matching is unavailable.

The package owns composition, audience selection, consent checks before sending,
and signed opt-in/out links and public pages. No platform unsubscribe-token API
or general bulk-mail primitive is introduced.
