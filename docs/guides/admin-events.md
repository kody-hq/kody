---
id: admin_events
title: Admin events
summary:
  Event topics that dispatch only to packages saved by users who hold the
  admin role: system inbox mail, platform feedback, community activity and
  listing publishes, status incidents, fleet health and entitlement crossings,
  auth and email delivery bursts, and account lifecycle notifications.
category: platform
adminOnly: true
---

# Admin events

These topics fan out only to packages saved by users who hold the admin role at
dispatch time. A non-admin package may declare them; it never receives the
event. Role revocation applies on the next dispatch.

Handlers run unattended as the package owner and carry that owner's admin role,
so they can call admin capabilities (for example `adminUserList` or
`adminSystemEmailGet`) without a signed-in session. Only save packages you trust
on an admin account: their code has the same admin reach you do.

Public package subscription topics live in
[Subscriptions and events](./package-subscriptions.md).

## `email.system-message.received` (admins)

Accepted mail stored in the operator-owned system inbox (`kody@<apex>`,
`support@<apex>`, and the other reserved system locals) dispatches
`email.system-message.received` to packages saved by users who hold the admin
role at dispatch time. Quarantined system-inbox mail is stored but never
dispatched. Non-admin subscribers never receive system mail.

The payload matches `email.message.received` (with
`event: 'email.system-message.received'`) plus an `admin_url` string linking to
the stored message in the admin interface (`/admin/system-email?messageId=...`).
Handlers run as the admin package owner, so the user-scoped email capabilities
and the `email` runtime helper cannot read the system message — use the metadata
and `admin_url` for notifications, and the admin `adminSystemEmailGet`
capability for full contents.

## `email.system-message.sent` (admins)

A successful `adminSystemEmailSend` / `sendSystemEmail` fans
`email.system-message.sent` to packages saved by users who hold the admin role
at dispatch time. This includes sends from the `@kentcdodds/system-email`
utility and raw capability calls. A non-admin package may declare the topic, but
it never receives the event. Role revocation stops delivery on the next send.

There is no Queue / DLQ for this topic. Dispatch is best-effort after the
provider send already succeeded: a failed invoke is logged and does not fail the
send or refund the daily cap.

Outbound system mail is not stored on the dedicated inbound `system_email_*`
graph (that graph refuses provider-message-id rows), so this topic carries the
sent correspondence itself — recipients, subject, text, and HTML — for admin
archive packages. It is the documented exception to metadata-only admin topics.

Handlers receive:

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

Idempotency keys include the topic, provider message id (or `sent_at` when the
provider omitted one), and subscriber package id. Deduplicate in package storage
on `provider_message_id` when a utility already recorded the same send.

## `platform.feedback.submitted` (admins)

A successful, consent-gated `metaPlatformFeedbackSubmit` insert enqueues a
durable `platform.feedback.submitted` attempt. The Queue consumer dispatches to
packages saved by users who hold the admin role when the message is processed. A
non-admin package may declare the topic, but it never receives the event. Admin
roles are read fresh for every attempt, so revocation stops delivery on the next
processed submission.

Handlers receive the explicitly approved feedback and attributed submitter
identity:

```ts
type PlatformFeedbackSubmittedEvent = {
	event: 'platform.feedback.submitted'
	content_warning: string
	admin_url: string
	feedback: {
		id: string
		category:
			| 'friction'
			| 'bug'
			| 'experience'
			| 'suggestion'
			| 'cancellation'
			| 'other'
		status: 'open'
		created_at: string
		summary_untrusted: string
		details_untrusted: string
	}
	submitter: {
		user_id: string
		username: string | null
		email: string | null
	}
}
```

`summary_untrusted` and `details_untrusted` are the exact feedback the user
explicitly approved. They remain user-authored untrusted data, and
`content_warning` tells handlers to treat them as feedback rather than
instructions. `admin_url` is built from the trusted deployment origin and links
to `/admin/platform-feedback?feedbackId=<encoded id>`, making it suitable for an
admin notifier. The event also includes the submitter's account user id,
username, and email snapshot stored with the submission. Retries never resolve
mutable live profile data, so an intervening account profile change cannot alter
the payload or its request hash. Rows without submitter snapshots retain null
`username`/`email`.

The event deliberately omits admin notes, reviewer fields, revision and update
metadata, roles, plan, and unrelated account content. This narrow delivery
exception applies only to the exact feedback the user approved after an agent
showed the proposed summary and details and asked first. Receiving the event
grants no role or user-data access beyond what the admin owner already holds.
Notification copies already delivered outside Kody cannot be recalled and may
remain after Kody account deletion under the deployment operator's retention and
deletion controls. Such copies contain only the exact approved feedback and
attribution, never unrelated account content.

The feedback row is durable before Kody awaits the small Queue enqueue. Enqueue
failure is logged but does not change the successful MCP response, avoiding a
duplicate submission when a client retries. Queue bodies remain opaque
`{ feedbackId }` messages. After admin subscribers are discovered, lazy
parameter construction reloads the feedback immediately before any invocation.
If deletion removed the row, dispatch throws a typed permanent cancellation and
the Queue consumer acknowledges it without invoking or retrying. Other lookup,
discovery, or package-invocation wrapper infrastructure failures retry before
eventually routing exhausted messages to the DLQ. The same idempotency key makes
redelivery safe, but a stored failed invocation replays rather than
automatically rerunning; the DLQ is the recovery surface. Terminal handler
execution failures are isolated without preventing attempts for sibling
subscribers.

## `community.activity.recorded` (admins)

Successful community fork and rating writes enqueue a durable
`community.activity.recorded` attempt. The Queue consumer dispatches only to
packages saved by users who hold the admin role when the message is processed.
Non-admin declarations are inert, and role revocation applies to the next
attempt.

Handlers receive activity metadata only:

```ts
type CommunityActivityRecordedEvent = {
	event: 'community.activity.recorded'
	event_id: string
	activity:
		| {
				id: string
				kind: 'fork'
				listing: { id: string; name: string; kody_id: string }
				actor: { username: string | null }
				occurred_at: string
		  }
		| {
				id: string
				kind: 'rating'
				listing: { id: string; name: string; kody_id: string }
				actor: { username: string | null }
				occurred_at: string
				stars: number
				adaptation_effort: number
		  }
}
```

The event omits stable user ids, email, forked package/source ids, target kody
ids, rating notes, package source, secrets, and unrelated account content.
One-click installs and ordinary forks both appear as `fork` because they share
the same existing `community_forks` row shape. Rating records are upserts, so
the reloaded activity contains the latest scores.

Queue messages contain only `{ eventId, kind, activityId }`. Dispatch reloads
the metadata projection after admin subscriber discovery. Missing activity is a
permanent cancellation; transient lookup, discovery, and package-invocation
infrastructure failures retry and can reach the dedicated DLQ. `event_id`
provides a distinct package-invocation idempotency key for every recorded write.

## `community.listing.published` (admins)

The first successful publish of a public package to Community enqueues a durable
`community.listing.published` attempt. Republishes record `listing_updated` in
the activity timeline but do **not** enqueue this subscription topic. The Queue
consumer dispatches only to packages saved by users who hold the admin role when
the message is processed. Non-admin declarations are inert, and role revocation
applies to the next attempt.

Handlers receive listing metadata only:

```ts
type CommunityListingPublishedEvent = {
	event: 'community.listing.published'
	event_id: string
	listing: {
		id: string
		name: string
		kody_id: string
		description: string | null
		public_url: string
	}
	publisher: {
		username: string | null
	}
	published_at: string
}
```

`public_url` is the canonical shareable URL
(`{base}/@{username}/{package-name}`), never `/community/{listing_id}`. The
event omits stable user ids, email, package source, secrets, and unrelated
account content.

Queue messages contain only `{ eventId, listingId }`. Dispatch reloads the
metadata projection after admin subscriber discovery. Missing, delisted, or
unpublished listings are a permanent cancellation; transient lookup, discovery,
and package-invocation infrastructure failures retry and can reach the dedicated
DLQ. `event_id` provides a distinct package-invocation idempotency key for every
first-publish enqueue. Enqueue failures are logged and never fail
`communityPublish`.

## `status.incident.opened` / `status.incident.resolved` (admins)

When the isolated status worker opens or resolves a component incident, it
best-effort POSTs a metadata-only payload to the main worker
(`POST /__maintenance/status-incidents`, shared bearer
`STATUS_INCIDENT_EVENT_SECRET`). The main worker fans out immediately to
packages saved by users who hold the admin role at dispatch time. A non-admin
package may declare the topic, but it never receives the event. Role revocation
stops delivery on the next incident.

There is no Queue / DLQ for these topics. A missing secret, a down main worker,
or a failed invoke is logged and skipped. Packages that also reconcile
`https://status.kody.codes/status.json` can catch an incident that is still
open, or still listed in recent history, on the next sweep. An incident that
opens and resolves between polls can be missed. Probe recording never waits on
fan-out.

Handlers receive operator telemetry only:

```ts
type StatusIncidentOpenedEvent = {
	event: 'status.incident.opened'
	status_url: string
	incident: {
		component: string
		detail: string | null
		started_at: string
	}
}

type StatusIncidentResolvedEvent = {
	event: 'status.incident.resolved'
	status_url: string
	incident: {
		component: string
		detail: string | null
		started_at: string
		resolved_at: string
	}
}
```

`status_url` is the public status page (`https://status.kody.codes`).
`component` is a status-page card id such as `app_db` or `app`. `detail` is the
probe reason (`timeout`, `error`, …) or `null`. Timestamps are ISO-8601 UTC. The
event omits probe logs, health-check bodies, user identities, secrets, and
unrelated account content. Idempotency keys include the topic, component,
timestamps, and package id so a retried POST does not double-invoke.

## `fleet.package_error_rate.elevated` (admins)

The hourly `usage_aggregation` lane queries Analytics Engine for anonymous fleet
totals of `package_export`, `package_static_call`, `job_run`, and
`workflow_run`. It compares the last completed hour to the hour before it, and
the last 24 hours to the 24 hours before that. Error totals use
`blob4 = 'error'` only: `package_static_call` throws that a successful run
handled are recorded as `caught` and do not inflate this alert (they remain in
admin usage rollups as `caughtCount` / `caught_count`, and in AE for per-package
drill-down via `blob3`). When the combined error rate rises past a volume floor,
Kody writes a KV snapshot for `/admin/insights` and fans
`fleet.package_error_rate.elevated` to packages saved by users who hold the
admin role at dispatch time. A second query then groups recent-window errors by
owner. One account at ≥80% of those errors, or three accounts together at ≥80%,
is concentrated; a true multi-user spike stays fleet-wide. Concentrated pages
still fan out to admin packages — they name the owning accounts instead of
looking like a fleet outage. A non-admin package may declare the topic, but it
never receives the event. Role revocation stops delivery on the next elevation.

There is no Queue / DLQ for this topic. A missed invoke is logged and does not
fail usage rollup aggregation. Hour elevations use a six-hour cooldown; day
elevations use a 24-hour cooldown. The same completed window end plus top owner
never re-pages even when the event id string would otherwise change hourly.

Handlers receive operator telemetry only:

```ts
type FleetPackageErrorRateElevatedEvent = {
	event: 'fleet.package_error_rate.elevated'
	event_id: string
	status_url: string
	insights_url: string
	environment: string
	observed_at: string
	trigger: {
		window: 'hour' | 'day'
		reason: 'absolute_delta' | 'relative_factor' | 'from_zero'
		recent: {
			start: string
			end: string
			combined: { events: number; errors: number; rate: number | null }
			by_metric: Array<{
				metric:
					'package_export' | 'package_static_call' | 'job_run' | 'workflow_run'
				events: number
				errors: number
				rate: number | null
			}>
		}
		previous: {
			start: string
			end: string
			combined: { events: number; errors: number; rate: number | null }
			by_metric: Array<{
				metric:
					'package_export' | 'package_static_call' | 'job_run' | 'workflow_run'
				events: number
				errors: number
				rate: number | null
			}>
		}
	}
	by_metric: Array<{
		metric:
			'package_export' | 'package_static_call' | 'job_run' | 'workflow_run'
		events: number
		errors: number
		rate: number | null
	}>
	concentration: {
		kind: 'one_account' | 'few_accounts' | 'fleet'
		recent_errors: number
		owner_count: number
		package_count: number
		top_owner_share: number
		owners: Array<{
			username: string
			error_share: number
			packages: Array<{ kody_id: string }>
		}>
	} | null
}
```

`status_url` is the public status page. `insights_url` is the operator insights
dashboard. Counts are fleet-wide and weighted by Analytics Engine
`_sample_interval`. `concentration` is present when the elevation query
succeeds. `owners` is populated only for `one_account` and `few_accounts` after
D1 resolves usernames and package name leaves. The event omits user ids, package
UUIDs, emails, error strings, logs, and unrelated account content. Idempotency
keys include the topic, event id, and subscriber package id.

Use this topic for notifier packages that enqueue a Kody-repo investigation
request. Agent spawning stays on the scheduled sweep, not in the subscription
handler. Do not treat this topic as permission to read another user's Activity
or package source.

## `fleet.entitlement.crossed` (admins)

The hourly `usage_entitlement_alert` lane sweeps the top ~15 active accounts
this UTC month (scored against each account's effective plan, including
temporary Pro gift / referral overlays; inbound `email_receives_per_day` uses
the base plan, matching inbound mail enforcement) and fans
`fleet.entitlement.crossed` to packages saved by users who hold the admin role
at dispatch time. A non-admin package may declare the topic, but it never
receives the event. Role revocation stops delivery on the next crossing.

One event fires per crossing of 80% (`approaching`) or 100% (`reached`) on a
specific entitlement, when a non-admin account first exceeds 24h of combined
execute / job / workflow runtime in the UTC month, when a non-admin account
first reaches a plan-aware unique Dynamic Worker cost threshold this UTC month
(Free $2, Standard $12, Pro $49; `max` and admin accounts do not page), or when
a non-admin account first hits 100% of `execute_unique_workers_per_day` on three
of the last seven UTC days. Staying over the same threshold does not emit again.
A later drop below that threshold, then a climb back over it, is a new instance.
A same-hour jump to 100% emits `reached` only and claims the 80% crossing so a
later drop into the 80–99% band stays silent. Execute-cap days are recorded on
durable hit keys so a later drop below 100% the same day does not erase the
train.

There is no Queue / DLQ for this topic. A missed invoke is logged and does not
fail the hourly sweep. Retry happens on the next hour if the crossing is still
unclaimed.

Handlers receive operator telemetry only:

```ts
type FleetEntitlementCrossedEvent =
	| {
			event: 'fleet.entitlement.crossed'
			kind: 'entitlement'
			user: { id: string; username: string }
			resource:
				| 'saved_packages'
				| 'scheduled_jobs'
				| 'repo_sessions'
				| 'email_sends_per_day'
				| 'email_receives_per_day'
				| 'stored_email_messages'
				| 'secrets'
				| 'concurrent_workflows'
				| 'storage_bytes'
				| 'execute_unique_workers_per_day'
				| 'outbound_fetches_per_day'
				| 'job_runs_per_day'
			label: string
			threshold: 'approaching' | 'reached'
			current: number
			limit: number
			percent_of_limit: number
			insights_url: string
			users_url: string
			observed_at: string
	  }
	| {
			event: 'fleet.entitlement.crossed'
			kind: 'runtime_duration'
			user: { id: string; username: string }
			total_duration_ms: number
			threshold_ms: number
			insights_url: string
			users_url: string
			observed_at: string
	  }
	| {
			event: 'fleet.entitlement.crossed'
			kind: 'repeated_entitlement'
			user: { id: string; username: string }
			resource: 'execute_unique_workers_per_day'
			days_at_limit: number
			window_days: 7
			threshold_days: 3
			insights_url: string
			users_url: string
			observed_at: string
	  }
	| {
			event: 'fleet.entitlement.crossed'
			kind: 'dynamic_worker_cost'
			user: { id: string; username: string }
			unique_worker_days: number
			estimated_gross_usd: number
			threshold_usd: number
			insights_url: string
			users_url: string
			observed_at: string
	  }
```

`user.id` is the stable account user id. `insights_url` and `users_url` are
operator dashboards. Timestamps are ISO-8601 UTC. The event omits emails, plan
names, secrets, package source, and unrelated account content. Idempotency keys
include the topic, user id, crossing kind, threshold or UTC month, resource, UTC
day for `*_per_day` resources and `repeated_entitlement`, and subscriber package
id.

Use this topic for notifier packages that send an operator message (for example
Discord) when an account first crosses a plan limit, repeats an execute cap, or
crosses the unique-worker cost line. Filter on `kind` if a busy-day 80% crossing
is too noisy. Do not treat this topic as permission to read another user's
packages, secrets, or Activity.

## User created and deleted (admins)

Password signup, social-login signup, and admin-created person accounts dispatch
`user.created` after the account row and default `user` role exist. Self-service
account deletion at `/account` dispatches `user.deleted` after the per-user
cascade finishes. Creating an org (`orgCreate`) does not emit `user.created`.

Production fan-out selects only packages whose owners hold the admin role at
dispatch time. A non-admin package may declare the topic, but it never receives
the event. Role revocation stops delivery on the next create or delete.

There is no Queue / DLQ for these topics. Dispatch is best-effort after the
account change commits: a failed invoke is logged and does not fail signup,
admin create, or account deletion.

Handlers receive a metadata-only identity snapshot:

```ts
type UserCreatedEvent = {
	event: 'user.created'
	user: {
		id: string
		username: string
		email: string
	}
	source: 'signup' | 'oauth' | 'admin'
	created_at: string
	attribution: {
		utm_source: string | null
		utm_medium: string | null
		utm_campaign: string | null
		utm_content: string | null
		utm_term: string | null
		landing_path: string | null
		referrer: string | null
	}
}

type UserDeletedEvent = {
	event: 'user.deleted'
	user: {
		id: string
		username: string
		email: string
	}
	deleted_at: string
}
```

`user.id` is the stable account user id. `source` is the create path that
committed. `attribution` is first-touch marketing UTMs and landing path/referrer
persisted on the account at signup (all null when absent). Timestamps are
ISO-8601 UTC. The event omits passwords, roles, plan, secrets, packages, and
unrelated account content. Notification copies already delivered outside Kody
cannot be recalled after account deletion. Idempotency keys include the topic,
user id, timestamp, and package id.

## `user.email_verification.failed` (admins)

The first terminal Cloudflare lifecycle event on a signup/verify send
(`bounced`, `failed`, `rejected`, or `complained`) fans
`user.email_verification.failed` to packages saved by users who hold the admin
role at dispatch time. A later replay of the same terminal state does not emit
again. A non-admin package may declare the topic, but it never receives the
event. Role revocation stops delivery on the next failure.

There is no Queue / DLQ for this topic. Dispatch is best-effort after the user
row already carries the bounce: a failed invoke is logged and does not fail
delivery-event processing.

Handlers receive a metadata-only operator snapshot:

```ts
type UserEmailVerificationFailedEvent = {
	event: 'user.email_verification.failed'
	user: {
		id: string
		username: string
		email: string
	}
	status: 'bounced' | 'failed' | 'rejected' | 'complained'
	class: 'sender_block' | 'other' | null
	admin_user_url: string
	occurred_at: string
}
```

`user.id` is the stable account user id. `class` is `sender_block` for
Fastmail-style domain/IP blocks (`RLR613`, `RLR813`, blacklist language),
`other` for generic terminal failures, or `null` when the event is not
classified. `admin_user_url` is the operator page for that account. Timestamps
are ISO-8601 UTC. The event omits SMTP transcripts, verification tokens,
passwords, roles, plan, secrets, and unrelated account content. Idempotency keys
include the topic, user id, timestamp, and subscriber package id.

Use this topic for notifier packages that email or page an operator when
signup/verify mail bounces or otherwise fails at the provider. Silent drops that
stay `accepted` use `user.email_verification.stalled`. `user.created` still
fires for every new person account, including accounts that later verify
themselves. To rescue the signup from a handler, see
[Rescuing a stalled signup from a handler](#rescuing-a-stalled-signup-from-a-handler).

## `user.email_verification.stalled` (admins)

The hourly `email_verification_stall_alert` lane lists unverified person
accounts whose latest signup/verify send is still `accepted` after 60 minutes
with no Cloudflare lifecycle event (`delivered`, `bounced`, `failed`,
`rejected`, or `complained`). Each matching send fans
`user.email_verification.stalled` to packages saved by users who hold the admin
role at dispatch time. The scan walks that derived set in pages of 50 using a KV
watermark so later sends are not starved behind the oldest unresolved rows. A
later hourly scan of the same accepted timestamp does not emit again. A resend
that stamps a new `accepted` time can emit again after another hour. A non-admin
package may declare the topic, but it never receives the event. Role revocation
stops delivery on the next scan.

There is no Queue / DLQ for this topic. Dispatch is best-effort after the user
row already carries `accepted`: a failed invoke is logged and does not fail the
hourly cron.

Handlers receive a metadata-only operator snapshot:

```ts
type UserEmailVerificationStalledEvent = {
	event: 'user.email_verification.stalled'
	user: {
		id: string
		username: string
		email: string
	}
	status: 'accepted'
	accepted_at: string
	stall_after_minutes: number
	admin_user_url: string
	occurred_at: string
}
```

`user.id` is the stable account user id. `accepted_at` is
`users.email_verification_delivery_at` for that send. `stall_after_minutes` is
the scan threshold (60). `occurred_at` is the scan time. `admin_user_url` is the
operator page for that account. Timestamps are ISO-8601 UTC. The event omits
SMTP transcripts, verification tokens, passwords, roles, plan, secrets, and
unrelated account content. Idempotency keys include the topic, user id, accepted
timestamp, and subscriber package id.

Use this topic for notifier packages that email or page an operator when a
signup is stranded without a bounce. SimpleLogin-style aliases can drop `kody@`
mail without a terminal Cloudflare event. Terminal failures still use
`user.email_verification.failed`. `/admin/users` and `adminUserList` accept
`verification=stalled` for the same derived set.

### Rescuing a stalled signup from a handler

A subscription handler for this topic (or for `user.email_verification.failed`)
may call `adminUserVerify`: `mint_verify_url` returns a one-time link to send
over a path that is not `kody.codes`, and `mark_verified` verifies the account
outright once ownership is proven. A job or webhook may do the same. Like every
site-admin capability, it runs only when the person the run acts for holds the
site `admin` role at call time (read fresh, so a revoked admin is refused at
once), and each call writes an extra audit row naming the trigger type and id
(see
[Site-admin capabilities from triggered runs](../contributing/architecture/authorization.md#site-admin-capabilities-from-triggered-runs)).
A non-admin automation is refused with
`MCP user lacks required role "admin" for capability "adminUserVerify"`.

## `user.email_outbound.paused` (admins)

The delivery-queue abuse lane pauses outbound sending after one spam complaint
or five bounced sends in a UTC day, then fans `user.email_outbound.paused` to
packages saved by users who hold the admin role at dispatch time. A later replay
of the same pause write does not emit again. A non-admin package may declare the
topic, but it never receives the event. Role revocation stops delivery on the
next pause.

There is no Queue / DLQ for this topic. Dispatch is best-effort after the pause
is already committed: a failed invoke is logged and does not fail delivery-event
processing.

Handlers receive a metadata-only operator snapshot:

```ts
type UserEmailOutboundPausedEvent = {
	event: 'user.email_outbound.paused'
	user: {
		id: string
		username: string
		email: string
	}
	reason: 'complained' | 'bounced'
	bounce_threshold: number | null
	admin_user_url: string
	occurred_at: string
}
```

`user.id` is the stable account user id. `bounce_threshold` is the daily bounce
count that triggered the pause (`5`) when `reason` is `bounced`, otherwise
`null`. `admin_user_url` is the operator page for that account. Timestamps are
ISO-8601 UTC. The event omits SMTP transcripts, message bodies, passwords,
roles, plan, secrets, and unrelated account content. Idempotency keys include
the topic, user id, timestamp, and subscriber package id.

Use this topic for notifier packages that email or page an operator when one
account's outbound sending is paused. Do not treat this topic as permission to
clear the pause — call the audited `resume_email_outbound` admin action after
review. Shared-domain pressure uses `email.delivery.burst`.

## `auth.denial.burst` (admins)

The hourly `auth_denial_alert` lane counts MCP auth failures
(`mcp_token_rejected`, `mcp_capability_denied`) in the last 60 minutes. When the
count crosses 50, it fans `auth.denial.burst` to packages saved by users who
hold the admin role at dispatch time. A six-hour KV cooldown suppresses repeat
pages on the same sustained spike. A non-admin package may declare the topic,
but it never receives the event.

There is no Queue / DLQ for this topic. A missed invoke is logged and does not
fail the hourly cron. Audit rows and `/admin/insights` remain the browse
surface.

Handlers receive operator telemetry only:

```ts
type AuthDenialBurstEvent = {
	event: 'auth.denial.burst'
	count: number
	threshold: number
	window_minutes: number
	insights_url: string
	observed_at: string
}
```

`insights_url` is the operator insights dashboard. The event omits user ids,
token ids, capability names, request bodies, and unrelated account content.
Idempotency keys include the topic, observed timestamp, and subscriber package
id.

Use this topic for notifier packages that page an operator when permission
probing or a compromised account is likely. Do not treat this topic as
permission to suspend an account.

## `email.delivery.burst` (admins)

The hourly `email_delivery_alert` lane counts platform-wide Cloudflare Email
Sending outcomes of `complained` or `bounced` in the last 60 minutes. When the
count crosses 20, it fans `email.delivery.burst` to packages saved by users who
hold the admin role at dispatch time. A six-hour KV cooldown suppresses repeat
pages. A non-admin package may declare the topic, but it never receives the
event.

There is no Queue / DLQ for this topic. A missed invoke is logged and does not
fail the hourly cron. Thin `email_delivery_alert_events` rows and the Email
delivery health chart on `/admin/insights` remain the browse surface.

Handlers receive operator telemetry only:

```ts
type EmailDeliveryBurstEvent = {
	event: 'email.delivery.burst'
	count: number
	threshold: number
	window_minutes: number
	insights_url: string
	observed_at: string
}
```

`insights_url` is the operator insights dashboard. The event omits user ids,
recipients, message bodies, SMTP transcripts, and unrelated account content.
Idempotency keys include the topic, observed timestamp, and subscriber package
id.

Use this topic for notifier packages that page an operator when the shared
sending domain is under platform-wide pressure. The per-user
`user.email_outbound.paused` topic still fires when one account is paused.
