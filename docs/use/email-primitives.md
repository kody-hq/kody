# Email primitives

Kody has a storage-first email surface for Cloudflare Email Service and Email
Routing. Each org has one inbox address at `{handle}@<platform domain>`, where
the handle is the org's slug (a personal org's slug is the owner's username) and
the platform domain is the deployment's user email domain: the
`USER_EMAIL_DOMAIN` env var when set, otherwise `inbox.` plus the hostname of
`APP_BASE_URL` (for example `you@inbox.kody.codes` or `acme@inbox.kody.codes`).
Kody receives routed mail for that address, stores parsed messages in the org
mailbox, and can send notify-self mail and replies from the matching
platform-assigned sender address.

## Addressing model

- Inbound mail to `{handle}@<platform domain>` routes to the org that owns that
  handle. A personal org's default inbox is provisioned at signup. Any org
  inbox, including a team org's, is created on first inbound mail if it is not
  there yet.
- Subaddressing (RFC 5233 plus addressing) is supported: mail to
  `{handle}+{tag}@<platform domain>` routes to that org's inbox (and
  `support+{tag}@<apex>` to the corresponding system inbox). The base local part
  — everything before the first `+` — is what routes, so a tag can never bypass
  the reserved or unknown-handle checks. Plus-tags on the org inbox host
  (`inbox.kody.codes` and any `getAcceptedUserEmailDomains` host) are org-inbox
  aliases, not reserved system locals: `you+kody@inbox…`, `you+support@inbox…`,
  and `you+admin@inbox…` deliver to `you` the same way `you+patch@inbox…` does.
  `kody@inbox…` with no plus (the handle itself is the reserved local) still
  rejects. System inboxes stay on the apex only (`kody@kody.codes` and the other
  `systemEmailLocals`). The full tagged address is preserved in the stored
  message's `to_addresses`, so a package subscribing to `email.message.received`
  can dispatch on the tag (for example, only handle mail addressed to
  `{handle}+invoices@...`).
- Mail to unknown handles is rejected, and the app's apex domain is never an org
  inbox: org mail lives exclusively on the configured platform domain (the
  `inbox.` subdomain by default), while the apex hosts only system mail — the
  transactional sender (`kody@<apex>`, used for verification, password-reset,
  billing, entitlement warnings, usage-campaign nudges (Kody tips, with an
  unsubscribe footer and `List-Unsubscribe` headers), and platform-feedback
  resolve/dismiss mail) and the operator-owned system inboxes (`kody`,
  `support`, `abuse`, `postmaster`, `security`, `admin`, and `psl` at the apex
  route to Kody's system inbox). `team@<apex>` is an inbound-only alias of
  `support@` (same inbox; original To kept; not a send-as address). Mail from
  `kody@<apex>` sets `Reply-To: support@<apex>` unless the caller supplies a
  different Reply-To, so human replies land at support rather than at the
  transactional sender. All other apex mail is rejected.
- Reserved local parts never route to an org inbox and can never be registered
  as usernames or slugs.
- Outbound user mail always sends from `{username}@<platform domain>` of the
  acting person, even when they are working in a team org. The from address is
  platform-assigned: a verified sender identity for it is provisioned
  automatically alongside the personal inbox. There is no self-service sender
  registration or verification step.

## Capabilities

Use the MCP `email` domain:

- `emailInboxList` lists inboxes and automatic platform addresses for the
  current org.
- `emailDestinationList` lists email destinations `emailSend` may use. The
  account identity email is always included. Extra addresses must be verified
  before `emailSend` can use them. Cap is 5 extras besides the account email.
  Mail comes from `{username}@<platform domain>`.
- `emailDestinationAdd` starts verification for an extra address, or resends the
  verification email if that address is already pending. The verification
  message is sent from your platform address (`{username}@<platform domain>`) on
  the same Cloudflare Email binding path as `emailSend` / `emailReply` — not
  from the apex transactional sender. Unused links from earlier sends stay valid
  until they expire or the address is verified. The account must be at least 24
  hours old (`users.created_at`). Verification mail is also limited to 3
  requests every 15 minutes per account, 10 per account per rolling 24 hours,
  and 3 per recipient address per rolling 24 hours across all accounts. A
  blocked request names which limit was hit and the UTC time to retry. The
  address is still saved, so a later retry or `adminEmailDestinationVerify` can
  finish it without another first-time add. Use a different address when the
  recipient cap is hit. Contact support if a new account needs a destination
  sooner. `adminEmailDestinationVerify` marks a saved address verified without
  sending mail, so it is not subject to these caps.
- `emailDestinationSetDefault` picks the destination used when `emailSend` omits
  `to`.
- `emailDestinationRemove` removes an extra destination. The identity email
  stays on the list.
- `emailSend` sends from your platform address to your verified email
  destinations. Destinations expand the allowed `to` set; Kody is not an open
  relay. Omit `to` to use the default destination (the account email until you
  pick another). Every explicit address must already be on that verified set; if
  any `to` is missing or unverified the whole send fails. Optional `attachments`
  (up to 10 of `{ filename, content_type, content_base64 }`) are sent with the
  message and stored as `external` attachments readable later via
  `emailAttachmentGet`. The same attachments go to every allowed `to` on one
  MIME message. With attachments, the whole message (bodies plus decoded
  attachment bytes) must fit the plan's `email_message_bytes` per-message cap.
  Manage destinations from `/@<slug>/-/email` as well. Unverified extras never
  receive mail.
- `emailReply` replies to a stored inbound message. The recipient always comes
  from the stored message. Optional `attachments` (up to 10 of
  `{ filename, content_type, content_base64 }`) are sent with the reply and
  stored as `external` attachments readable later via `emailAttachmentGet`. With
  attachments, the whole message (bodies plus decoded attachment bytes) must fit
  the plan's `email_message_bytes` per-message cap.
- `emailAttachmentGet` returns stored attachment bytes by attachment id.
- `emailMessageList` lists stored inbound and outbound messages. Rows include
  `classification` and `classification_reason` and omit parsed bodies; pass an
  optional `classification` filter (`accepted` or `quarantined`) to narrow the
  list. Call `emailMessageGet` when a handler needs body text.
- `emailMessageSearch` searches stored messages by case-insensitive substring
  match against the subject, header `From`, and envelope sender. It accepts the
  same `inbox_id` / `direction` / `processing_status` / `delivery_status`
  filters and limit caps as `emailMessageList`. Search rows also omit bodies.
- `emailMessageGet` returns parsed bodies, headers, thread metadata, and
  attachment metadata.
- `emailMessageDelete` deletes one stored inbound or outbound message owned by
  the signed-in user. Missing and foreign ids fail. Deleting frees a
  `stored_email_messages` slot so new inbound mail can be accepted again. The
  same delete is available on `/@<slug>/-/email`.
- `emailMessageClassify` reclassifies a stored inbound message as `accepted` or
  `quarantined`. Reclassification never retroactively dispatches package
  subscription events.
- `emailSenderRuleList` lists sender allow/block/quarantine rules.
- `emailSenderRuleSet` creates or updates a sender rule by address or domain
  (`kind` / `value` / `effect` / optional `note`).
- `emailSenderRuleDelete` deletes one sender rule by id. Each user may store at
  most 200 sender rules.
- `emailDeliveryEventList` lists stored delivery history, including final Email
  Sending outcomes, SMTP responses, bounces, rejections, and complaints.
- `usageGet` (account domain) returns the signed-in user's entitlement usage and
  limits, including stored email message count, today's send and receive counts,
  the applicable caps, and the plan name.

## Quotas

Inbound storage is quota-gated per user:

- A per-message persist cap (`email_message_bytes`), a daily receive limit
  (`email_receives_per_day`), and a stored-message cap (`stored_email_messages`)
  apply at storage time. Mail over the daily or stored-message caps is rejected
  at the routing layer with a generic "over quota" response to the sender, and
  the detailed reason is recorded as a `rejected` delivery event. Wire size
  above 25 MiB (Cloudflare Email Routing's inbound ceiling) is rejected before
  it consumes any daily receive quota. Mail to unverified accounts (which can
  never receive) is rejected without consuming any quota at all. Messages at or
  under the owner's persist cap — including a `multipart/related` body with an
  embedded image — are stored as-is. Larger accepted mail is stored with the
  text kept and oversized parts omitted (`emailAttachmentGet` returns no bytes).
  Transient storage failures (for example an R2 outage while saving raw MIME) do
  not keep the daily receive charge — the attempt is refunded so delivery
  retries are not blocked by quota.
- Plan users get their plan's limits. New accounts start on the `free` plan. The
  operator-only `max` plan uses finite email caps (10,000 sends/day, 20,000
  receives/day, 100,000 stored messages, 768 KiB per message); it is not a
  public or paid tier.
- Free email caps are 10 sends/day, 10 receives/day, 100 stored messages, and
  256 KiB per message. Paid email caps are Standard: 200 sends/day, 1,000
  receives/day, 10,000 stored messages; Pro: 500 sends/day, 2,000 receives/day,
  25,000 stored messages. Both paid plans allow up to 768 KiB per message.
- Quota, size, and unverified-account rejections store at most five detailed
  `rejected` delivery events per inbox per UTC day; further rejections increment
  a single daily aggregate event (with a total count and the last reason) so
  rejected floods cannot grow storage. Parse-failure rejections keep one event
  per attempt — they are already bounded by the daily receive quota and the
  detail helps debug a misbehaving sender.
- Outbound sending stays limited by `email_sends_per_day` for plan users.
- Check where you stand with `usageGet`. When `stored_email_messages` is at the
  cap, inbound mail is rejected at routing and `email.message.received`
  subscriptions do not fire. Delete messages you no longer need with
  `emailMessageDelete` or from `/@<slug>/-/email` to free slots. Mailbox
  retention does not keep Free-tier inboxes under the stored-message cap.

## Safety model

- Every email capability requires a **verified account email**. Until the
  account email is verified (via the link sent at signup, or a resend from the
  `/account` page), email capabilities are rejected, inbound mail routed to the
  account's platform address is rejected before storage, and MCP access as a
  whole is disabled.
- Any email routed to a verified user's platform address is stored, subject to
  the quotas above.
- Unknown usernames and reserved local parts outside the configured system
  address subset are rejected before storage. Configured system addresses are
  stored in the operator-owned system inbox and are visible only to admins.
- Display names are not trusted. Kody stores envelope sender, parsed `From`, and
  authentication headers separately.
- Outbound sending requires a verified account email, sends only from the
  platform-assigned address, and `emailSend` only delivers to the signed-in
  user's verified email destinations (the account identity email plus extra
  addresses they added and verified). Kody is not an open relay: destinations
  only expand the allowed `to` set. `emailReply` is the only way for a user
  account to address external recipients, and only recipients taken from stored
  inbound mail. Admins have a separate operator channel (`adminSystemEmailSend`)
  that speaks for the platform rather than for any user account: it sends from a
  reserved system sender, uses no user mailbox or plan entitlement, is
  audit-logged, and is capped per sender per UTC day.
- Outbound sends consume a per-day entitlement. The `max` plan allows 10,000
  send attempts per UTC day.
- A successful send request has `processing_status: "sent"`. Cloudflare delivery
  events independently populate `delivery_status` with `delivered`, `deferred`,
  `bounced`, `failed`, `rejected`, or `complained`; use `emailDeliveryEventList`
  for the event history and SMTP details.
- Delivery events feed an automatic abuse pause: one spam complaint, or five or
  more bounced sends within a UTC day, pauses outbound sending for the account
  (receiving is unaffected). Every user sends from the same platform domain, so
  one account's complaints damage delivery for everyone. A paused send fails
  with a clear error; contact the operator to have the pause reviewed and
  cleared.
- System inbox mail is not gated by a user plan or account-verification state.
  It has fixed platform caps and retention: messages are pruned after 90 days
  and the stored system inbox is capped so arbitrary sender traffic cannot grow
  without bound. Operator sends from a system address are capped separately from
  receives, so a runaway sender can never block inbound system mail.
- Stored inbound mail is the source of truth. If a user wants email automation,
  they can publish a package that subscribes to the stored inbound email topics
  `email.message.received` or `email.message.quarantined` using normal package
  subscriptions. This is package behavior, not a separate Kody-owned email
  handler or agent-loop primitive.
- Subscription event payloads are metadata-first. Package handlers receive the
  stored message id and receipt metadata, then use `emailMessageGet` or
  `emailAttachmentGet` (or `import { email } from 'kody:runtime'`) when they
  need bodies or attachment bytes.
- Subscription handlers run with the normal package runtime context: signed-in
  package user, package-owned storage via `packageStorage()`
  (`package:{encodeURIComponent(packageId)}`), package/repo context, and the
  standard capability registry subject to the usual secret and capability
  approval rules. For `email.message.received` and `email.message.quarantined`,
  `import { email }` from `kody:runtime` is available as a convenience helper
  for message lookup, attachment lookup, and replies.
- Attachments are metadata-first by default. Accepted inbound raw MIME is stored
  in R2 at or under the owner's plan `email_message_bytes` persist cap
  (`maxRawMimeBytes` / `maxKeptInboundRawBytes`, 256 KiB free and 768 KiB
  paid/max). The reader accepts wire size up to 25 MiB and reduces anything
  above the persist cap: text and HTML stay, oversized parts are recorded as
  `unavailable` attachments. On-demand attachment lookup reconstructs bytes from
  the stored raw MIME when the part was kept; omitted parts return no bytes.
- Cloudflare Email Routing already rejects mail that fails both SPF and DKIM and
  honors sender DMARC policy before Kody sees the message. Kody's own spam
  controls (below) run on mail that still reaches storage.

## Spam controls

Inbound mail is classified at receive time. Each stored message carries
`classification` (`accepted` or `quarantined`) and an optional human-readable
`classification_reason`. Decision order:

1. **Authentication-Results verdict** — Kody parses the stored SPF/DKIM/DMARC
   results first. DMARC `fail`, or SPF `fail`/`softfail` without a DKIM `pass`,
   marks the message suspect. A missing Authentication-Results header fails open
   (not authenticated, not suspect).
2. **Per-org sender rules** — at classification time, rules match the RFC5322
   From address (exact address or domain, including subdomains; address beats
   domain). Early SMTP `block` still uses the envelope sender. Effects:
   - `block` rejects at SMTP before any receive quota is charged (envelope
     match), and quarantines at classification when From matches.
   - `quarantine` stores the message as quarantined.
   - `allow` stores the message as accepted only when From authenticates (DMARC
     `pass`, or SPF `pass` with the envelope on the From domain). Spoofed or
     unaligned From is never accepted because of an allow rule.
3. **Default** — when no sender rule decides the outcome, suspect mail is
   quarantined and everything else is accepted.

Each org may store at most 200 sender rules. Manage them with
`emailSenderRuleList`, `emailSenderRuleSet` (kind / value / effect / note), and
`emailSenderRuleDelete`. Reclassify a stored inbound message with
`emailMessageClassify`, or filter `emailMessageList` by `classification`.

On `/@<slug>/-/email`, quarantined messages show a Quarantined badge (with the
reason as tooltip/secondary text), the list can filter to Quarantined only, and
inbound messages offer Mark as spam / Not spam actions that call the same
reclassification path.

Subscription dispatch uses the receive-time classification exactly once:
accepted mail fires `email.message.received`; quarantined mail fires
`email.message.quarantined` instead. Later reclassification never retroactively
dispatches either topic.

## Who an inbound email runs as

Mail to `{slug}@inbox.kody.codes` is stored on the org mailbox. A personal org's
address is still `{username}@`, because that username is the org's handle. Owner
and Admin see every accepted message. A package runs only when one of its live
enablements has a sender rule that matches. There is no blanket switch and no
fallback to the inbox owner.

An Owner or someone with `email:read` turns a package on for one sender from the
message on `/@<slug>/-/email`. That opens the credential approval page with
`sender_kind` and `sender_value` filled in (`member` plus the person's id, or
`address` plus From). `enablementEnable` cannot turn `email.message.received` or
`email.message.quarantined` on.

Before any subscription runs, Kody classifies the sender. From authenticates
only on DMARC `pass`, or SPF `pass` with the envelope sender on the From domain.
A DKIM `pass` alone is not enough, and a missing Authentication-Results header
does not authenticate From.

- **Org member.** The From address is the verified account email of a current
  member, and the message authenticated that address. Only packages that member
  can run (`package:execute`) are considered. An enablement matches when its
  sender rule is `member` and the value is that person's id. The run acts as the
  enablement's enabler. Every credential the run resolves is checked and audited
  under that enabler. If the enabler lost access, the credential is denied when
  the run reads it and the run fails. It never retries with another identity or
  credential.
- **Authenticated non-member** (receipts, notifications, outside collaborators,
  people who left the org). The From address authenticated. Packages run only
  for enablements whose sender rule matches: an exact address, a From domain, or
  `any_authenticated`. Unmatched mail stays in the admin inbox and runs nothing.
- **Unverified or spoofed.** Mail that failed authentication (DMARC `fail`, or
  SPF `fail`/`softfail` without DKIM `pass`), mail with no From address, mail
  whose From did not authenticate (including DKIM-only), and mail that claims a
  member address without authenticating it (or from a member whose account email
  is unverified or whose account is suspended) runs nothing. An `allow` rule
  never accepts auth-failed mail; other stored messages (including fail-open
  missing Authentication-Results) still stay visible on `/@<slug>/-/email`, and
  the worker logs `inbound-email-sender-unverified` with the reason.

A personal org may have an `any_authenticated` catch-all on a live email
subscription so any authenticated sender runs that package. Narrow that row for
a specific sender. A live row with no sender rule does not match. Team orgs
start with no email enablements.

Email runs are still billed to the enabler, in the org that owns the inbox.

## `email.message.received` package subscription

Accepted stored inbound email dispatches the package subscription topic
`email.message.received` after the message and attachment metadata are stored.
Quarantined mail uses `email.message.quarantined` instead (same payload shape,
different event name). Packages subscribe in `package.json#kody.subscriptions`:

```json
{
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail."
			}
		}
	}
}
```

Handlers receive a metadata-first payload:

```ts
type EmailMessageReceivedEvent = {
	event: 'email.message.received'
	message: {
		id: string
		inbox_id: string | null
		from_address: string | null
		envelope_from: string | null
		to_addresses: Array<string>
		cc_addresses: Array<string>
		reply_to_addresses: Array<string>
		subject: string | null
		message_id_header: string | null
		in_reply_to_header: string | null
		references: Array<string>
		processing_status: 'stored' | 'sent' | 'failed'
		received_at: string | null
		created_at: string
	}
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		storage_key: string | null
		created_at: string
	}>
}
```

The event does not include parsed bodies or attachment bytes. Fetch those only
when the handler needs them with `emailMessageGet`, `emailAttachmentGet`, or the
package runtime `email` helper. Use `packageSubscriptionsList` with
`topic: "email.message.received"` or `topic: "email.message.quarantined"` to
discover which saved packages subscribe for the signed-in user.

## `email.message.quarantined` package subscription

Quarantined stored inbound email dispatches `email.message.quarantined` instead
of `email.message.received`. The payload shape matches
`EmailMessageReceivedEvent` with `event: 'email.message.quarantined'`. Packages
that should react to spam or suspect mail subscribe to this topic; packages that
only want trusted inbound mail stay on `email.message.received`.

## `email.message.delivery.updated` package subscription

Cloudflare Email Sending lifecycle events dispatch
`email.message.delivery.updated` after Kody correlates the provider message id,
stores the event idempotently, and updates the outbound message's latest
delivery status. Email Routing events are not part of this topic.

The metadata-first payload contains the owned Kody message and the provider
delivery event:

```ts
type EmailMessageDeliveryUpdatedEvent = {
	event: 'email.message.delivery.updated'
	message: {
		id: string
		inbox_id: string | null
		thread_id: string | null
		from_address: string | null
		to_addresses: Array<string>
		subject: string | null
		processing_status: 'stored' | 'sent' | 'failed'
		provider_message_id: string | null
		delivery_status:
			| 'delivered'
			| 'deferred'
			| 'bounced'
			| 'failed'
			| 'rejected'
			| 'complained'
			| null
		delivery_status_at: string | null
		sent_at: string | null
		created_at: string
	}
	delivery: {
		event_id: string
		status: NonNullable<
			EmailMessageDeliveryUpdatedEvent['message']['delivery_status']
		>
		terminal: boolean
		sender: string
		recipient: string
		delivery: Record<string, unknown>
		bounce: Record<string, unknown> | null
		failure: Record<string, unknown> | null
		rejection: Record<string, unknown> | null
		complaint: Record<string, unknown> | null
		occurred_at: string
	}
}
```

`deferred` means Cloudflare still has delivery retries pending; handlers should
not independently resend the message. Cloudflare automatically suppresses hard
bounces and spam complaints. Out-of-order events remain in delivery history but
do not dispatch after a newer delivery state has already been stored.

## `email.system-message.received` package subscription (admins)

Mail stored in the operator-owned system inbox (`kody`, `support`, `abuse`,
`postmaster`, `security`, `admin`, and `psl` at the apex) dispatches the
separate package subscription topic `email.system-message.received` when the
message is accepted. It fans out to packages saved by users who hold the admin
role at dispatch time — a non-admin saving the same subscription never receives
system mail, and a revoked admin stops receiving immediately.

Quarantined system-inbox mail is stored for operators but never dispatches
`email.system-message.received` (or any other admin package subscription).
Operators manage system sender rules with `adminSystemEmailSenderRuleList`,
`adminSystemEmailSenderRuleSet`, and `adminSystemEmailSenderRuleDelete` (same
address/domain matching and effects as user sender rules, scoped to the
`system:email` owner).

The payload is the same metadata-first envelope as `email.message.received`
(with `event: 'email.system-message.received'`), plus one extra field:

```ts
type SystemEmailMessageReceivedEvent = Omit<
	EmailMessageReceivedEvent,
	'event'
> & {
	event: 'email.system-message.received'
	/** Link to the stored message in the admin interface. */
	admin_url: string
}
```

Handlers run as the admin package owner, not the system owner, so the
user-scoped email capabilities and the `kody:runtime` `email` helper cannot read
the system message. Use the metadata for routing and notifications (for example
a Discord report), and follow `admin_url` (or the admin `adminSystemEmailGet`
capability) for full contents. Admins can remove unwanted system mail with
`adminSystemEmailDelete({ message_id })` (attachments, charged delivery rows,
blobs, and an empty parent thread included). The inbound fingerprint pointer is
tombstoned as rejected until the 48-hour dedupe window expires, so provider
retries do not recreate the message.

## `email.system-message.sent` package subscription (admins)

A successful send from a reserved system sender (`adminSystemEmailSend` /
`sendSystemEmail`) fans `email.system-message.sent` to packages saved by users
who hold the admin role at dispatch time. Raw capability calls and utility
wrappers both go through that send path, so archive packages see every operator
send.

Outbound system mail is not stored on the dedicated inbound `system_email_*`
graph, so this topic carries the sent copy (recipients, subject, text, and HTML)
rather than a metadata-only pointer. Production fan-out is admin-only; synthetic
dispatch still runs a named handler for smoke tests.

```ts
type SystemEmailSentEvent = {
	event: 'email.system-message.sent'
	from: string
	to: Array<string>
	subject: string
	text: string | null
	html: string | null
	reply_to: string | null
	provider_message_id: string | null
	sent_at: string
}
```

## Local inbound testing

Run the worker locally with `APP_BASE_URL` set, sign up a user, then post raw
MIME to Wrangler's email test endpoint addressed to
`{username}@inbox.<APP_BASE_URL hostname>` (or `{username}@<USER_EMAIL_DOMAIN>`
when the override is set). The local worker defaults to port `3742` unless you
set `PORT`:

```sh
curl --request POST \
  'http://localhost:3742/cdn-cgi/handler/email?from=sender@example.com&to=username@inbox.example.com' \
  --data-raw 'From: Sender <sender@example.com>
To: Username <username@inbox.example.com>
Subject: Hello
Message-ID: <hello@example.com>

Hello from local email routing.'
```

Then inspect the message with `emailMessageList`, `emailMessageSearch`, and
`emailMessageGet`.
