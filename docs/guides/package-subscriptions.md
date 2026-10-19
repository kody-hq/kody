---
id: package_subscriptions
title: Package subscriptions and events
summary:
  Use package.json#kody.subscriptions for package-owned event handlers; discover
  subscribers with packageSubscriptionsList; smoke-test one handler from
  interactive MCP with packageSubscriptionDispatch; follow metadata-first email,
  run.error.recorded activity notifiers, integration.auth.failed /
  integration.auth.succeeded reconnect notifiers, mcp.server.disconnected /
  mcp.server.reconnected connection episodes, follow.published / follow.pushed
  follow notifiers, community.fork.upstream_updated fork notifiers, and repo /
  package lifecycle topics.
category: platform
---

# Package subscriptions and events

Use package subscriptions when a saved package should react to Kody-owned event
topics. The saved package remains the top-level entity; subscriptions are nested
manifest metadata and package runtime handlers.

Watch:
[Kody subscriptions: email and Discord events wake your agents](https://www.youtube.com/watch?v=8I6kYYiaqis).

## Manifest shape

Declare subscriptions in `package.json#kody.subscriptions` as a record keyed by
event topic:

```json
{
	"name": "@scope/email-automation",
	"exports": {
		".": "./src/index.ts"
	},
	"kody": {
		"description": "Automates stored inbound email.",
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail."
			}
		}
	}
}
```

Each subscription definition supports:

- `handler` (required): package-local module path for the event handler.
- `description` (optional): human-readable purpose for package detail and
  subscription listings.
- `filters` (optional): topic-specific metadata reserved for dispatchers.

Package checks normalize handler paths and build published bundle artifacts for
subscription handlers. Runtime dispatch invokes the handler through the normal
package execution path with package context, package-owned storage,
package-owned secrets, and `kody:runtime`.

## Discovery

Use `search` for package subscription work, then call the built-in
`packageSubscriptionsList` capability to inspect the signed-in user's declared
subscriptions:

```json
{
	"topic": "email.message.received"
}
```

The result lists scoped package `name`, `package_id`, topic, handler,
description, and filters. Use this before debugging event dispatch, building
fan-out, or deciding whether a package already subscribes to a topic.

Host wake paths (email, Discord-driven package events, webhooks that fan out via
subscriptions, integrations, and the other subscription discovery helpers) read
a per-user KV cache of the computed topic→package map rather than loading every
saved package manifest. The manifest remains the only source of truth; publish
and unpublish refresh the cache. Prefer that pattern (normalized source +
computed cache, invalidate on the write that changes the source, no TTL) over a
denormalized topic-index table.

## Local testing before publish

MCP-only agents validate unpublished subscription wiring with `repoRunChecks`,
publish, then smoke with `packageSubscriptionDispatch` (below).

When Node ≥22 and `@kodycodes/cli` are available, you can also exercise the
handler locally before publish with `kody dev emit`:

```bash
npx @kodycodes/cli@latest dev emit email.message.received --body ./fixtures/event.json
```

That delivers the platform subscription envelope (`synthetic: true`, and an
`idempotency_key` when the body omits one) to the local handler declared in
`package.json#kody.subscriptions`. On `--target mock` (the `kody dev` default),
any declared event type is allowed — the mock does not restrict to the live
platform catalog. See
[Package lifecycle → Validate and test before publish](./package-lifecycle.md#validate-and-test-before-publish)
for the other surfaces (exports, jobs, webhooks) and for hosts without a CLI.

## Synthetic dispatch

`packageSubscriptionDispatch` is the **interactive MCP** post-publish smoke test
for **one** declared subscription handler on **one** owner-scoped saved package.
It is a platform-marked real-surface run with real side effects. Call it after
publish to verify handler wiring without waiting for production fan-out.

Package reuse is a static `import … from 'kody:@scope/pkg/export'` (declare
`kody.dependencies`). See [Package reuse](../use/packages.md#package-reuse).

Reuse the scoped `name` from `packageSubscriptionsList` as `kody_id`.

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "email.message.received",
	"params": {}
}
```

For stored inbound mail, replay with `email_message_id` instead of `params`:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "email.message.received",
	"email_message_id": "00000000000000000000000000000001"
}
```

Pass exactly one of `params` or `email_message_id`. There is no caller
`idempotency_key` — the platform generates internal idempotency keys.

Final `published` and `already_published` results from
`packagePublishExternalPush` include `test_hints.subscriptions[]` with a starter
snippet per declared topic when subscriptions are present. For a `dispatched`
result, poll the workflow to completion before reading its final publish result.
Failed and non-fast-forward results have no test hints. The CLI
(`kody package publish`) exits 0 for those success statuses (and for
`dispatched`); refusal statuses exit 1 with the error on stderr.

### Handler guidance

- **Platform markers.** The platform sets top-level `synthetic: true` and, for
  stored-mail replay, `replay_of`. Real event dispatch strips caller-supplied
  `synthetic` and `replay_of` from handler envelopes. Run records agree with the
  handler payload.
- **`params` or `email_message_id`.** Fixture `params` merge into the handler
  envelope before markers are added. `email_message_id` rebuilds the stored
  inbound email envelope from D1.
- **Treat synthetic identically to production.** Handlers run the same code path
  unless a deliberately visible irreversible-side-effect guard says otherwise.
- **Start minimal.** Begin with `{}` or the smallest object your handler
  accepts, then add fields until the smoke test covers the branches you care
  about.
- **Filters are not applied.** Production dispatch for package-emitted topics
  skips subscribers when `filters` do not match the payload; synthetic dispatch
  always runs the named package. Put filter-matching fields inside `params` when
  testing filter-dependent code paths.
- **Admin-only topics** gate **production** fan-out on admin role; synthetic
  dispatch still runs your handler directly for smoke testing. Signed-in admins
  can read those topics in the Admin docs section.
- **Activity.** Synthetic runs appear on the `subscription` surface. Handler
  failures do not emit `run.error.recorded` (recursion guard).

Full call semantics and examples:
[Synthetic event dispatch](../use/synthetic-event-dispatch.md).

## Package-emitted topics (`@scope/...`)

Packages can define their own event topics and emit to them; every other package
saved by the same user that declares the topic in `kody.subscriptions` receives
the event. There is no cross-user delivery.

### Declaring emitted topics

Declare topics in `package.json#kody.emits`. Topics must use the scoped form
`@{username}/topic.name` with a lower-dot-case body, and the scope must match
the emitting package's npm scope. Set `"mcp": true` on a topic to also expose it
over [MCP Events](./mcp-events.md) (flag-gated; nothing is exposed by default):

```json
{
	"name": "@kentcdodds/discord-gateway",
	"kody": {
		"description": "Discord gateway.",
		"emits": {
			"@kentcdodds/discord.message.created": {
				"description": "A Discord message was created.",
				"payloadSchema": {
					"type": "object",
					"properties": {
						"messageId": { "type": "string", "minLength": 1 },
						"channelId": { "type": "string" }
					},
					"required": ["messageId", "channelId"],
					"additionalProperties": false
				}
			}
		}
	}
}
```

`payloadSchema` is optional. When present it must be a JSON Schema subset with
root `"type": "object"`; supported keywords are `type`, `description`,
`properties`, `required`, `additionalProperties` (boolean), `items`, `enum`,
`const`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, and
`maxItems`. Unsupported keywords fail package checks at publish time so authors
never rely on silently ignored constraints. Declared schemas appear in package
search/detail projections so subscribers can discover payload shapes.

### Emitting

`events` is bound only in package jobs, subscription handlers, and package apps.
Emit from those runtimes (including package modules they load):

```ts
import { events } from 'kody:runtime'

await events.dispatch({
	topic: '@kentcdodds/discord.message.created',
	idempotencyKey: `discord:message-create:${message.id}`,
	payload: { messageId: message.id, channelId: message.channelId },
})
```

Rules:

- The topic must be declared in the emitting package's `kody.emits`.
- `idempotencyKey` is required; payloads must be JSON objects and are validated
  against `payloadSchema` when declared.
- Payloads are capped at 64 KiB (canonical JSON). Store large data with
  `packageStorage()` and emit a reference instead.
- `events.dispatch` is unavailable in ad hoc `execute` runs — topics belong to
  packages. Statically importing a package export from `execute` does not bind
  `events`.

### Delivery semantics

Dispatch is asynchronous and durable: `events.dispatch` validates the event,
enqueues it on the `kody-package-events-dispatch` Queue (with DLQ), and returns
`{ topic, source, idempotencyKey, status: "enqueued" }` immediately. Emitters
never observe subscriber results or latency; check each subscriber's run records
for handler outcomes.

The Queue consumer resolves the emitting user's subscribed packages at delivery
time and invokes each `subscription:@scope/topic` handler with:

```ts
type PackageEventEnvelope = {
	event: string
	source: { type: 'package'; package_id: string; kody_id: string }
	idempotency_key: string
	payload: Record<string, unknown>
}
```

- Per-subscriber invocations are exactly-once keyed on
  `(source package, subscriber package, topic, idempotencyKey)`, so Queue
  redelivery replays stored results instead of re-running handlers.
- Infrastructure failures before handler code runs retry via the Queue (3
  attempts, then the `kody-package-events-dispatch-dlq` dead-letter queue).
  Terminal handler failures do not retry — a stored failed invocation replays
  rather than re-running — and stay visible in run records.
- Event-driven chains carry a nested invocation depth budget (max 8 hops), so
  emit cycles between packages terminate.
- In environments without the Queue binding (local dev, preview) — or when an
  enqueue fails — dispatch falls back to inline delivery with the same consumer
  code path and reports `status: "delivered_inline"` instead of `"enqueued"`.

### Filters on package-emitted topics

A subscription to a package-emitted topic may declare `filters`; every filter
key must be present in the event payload with an equal JSON value or the
subscriber is skipped:

```json
{
	"kody": {
		"subscriptions": {
			"@kentcdodds/discord.message.created": {
				"handler": "./src/on-general-chat-message.ts",
				"filters": { "channelId": "1470913684598423592" }
			}
		}
	}
}
```

Platform-owned topics (below) keep their existing behavior: their dispatchers
define whether and how `filters` apply.

## `email.message.received`

Accepted stored inbound email dispatches `email.message.received` after Kody
stores the message and attachment metadata. Quarantined mail uses
`email.message.quarantined` instead.

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

Do not expect parsed bodies or attachment bytes in the event. Fetch full message
bodies, parsed headers beyond the event metadata, or attachment bytes only when
the handler needs them with `emailMessageGet`, `emailAttachmentGet`, or the
package runtime `email` helper.

## `email.message.quarantined`

Quarantined stored inbound email dispatches `email.message.quarantined` instead
of `email.message.received`. The payload matches `email.message.received` with
`event: 'email.message.quarantined'`. Reclassifying a message later does not
retroactively dispatch either topic. `email.reply` refuses that message
(`quarantined_inbound_reply`) until it is released with `emailMessageClassify`
(`classification: "accepted"`) or Not spam on `/@<slug>/-/email`.

## `email.message.delivery.updated`

Outbound Email Sending lifecycle changes dispatch
`email.message.delivery.updated`. The payload contains metadata for the owned
Kody message plus the provider event id, delivery status, terminal flag,
recipient, SMTP delivery fields, optional bounce/failure/rejection/complaint
details, and provider event timestamp.

Use this topic for delivery notifications and bounce or complaint workflows. Do
not resend on `deferred`: Cloudflare still has provider retries pending.
Provider event ids are stored idempotently, so duplicate Queue delivery does not
dispatch duplicate package invocations. Out-of-order events remain available in
delivery history but do not dispatch after a newer status.

## `run.error.recorded`

When a user-scoped Activity / run record finishes with `status: 'error'`, Kody
dispatches `run.error.recorded` to packages saved by that same user that declare
the topic. Delivery is best-effort after a successful run-record Durable Object
write — there is no Queue / DLQ for this topic. Failures during subscriber
discovery or package-invocation infrastructure are logged and do not fail the
observed run.

Handlers receive a metadata-first payload:

```ts
type RunErrorRecordedEvent = {
	event: 'run.error.recorded'
	run: {
		id: string
		surface: string
		name: string | null
		package_id: string | null
		kody_id: string | null
		source_id: string | null
		published_commit: string | null
		storage_id: string | null
		job_id: string | null
		workflow_id: string | null
		invocation_id: string | null
		session_id: string | null
		parent_run_id: string | null
		started_at: string
		finished_at: string | null
		duration_ms: number | null
		error_name: string | null
		error_message: string | null
	}
	activity_url: string
}
```

`activity_url` is built from the trusted deployment origin and links to
`/@<slug>/-/activity/<runId>`. The event deliberately omits log lines and the
full run `metadata` blob — fetch detail with `runGet` when needed. Error name
and message use the same truncation budget as the stored run record.

Recursion guard: runs whose surface is `subscription` never emit this event.
Subscription-handler failures themselves create run records; emitting again
would recurse. Successful runs and `execute` successes (which are not persisted)
never emit. Failed `execute` calls do persist and do emit.

Use this topic for notifier packages that email, write to Sheets, spawn an
agent, or otherwise react when something in the user's account fails.

## `integration.auth.failed`

When host-side OAuth token refresh fails with reconnectable caller state —
missing refresh token on a sign-in that expires, provider HTTP 4xx /
`invalid_grant`, missing secrets, host-approval gaps, or invalid connection
config — Kody dispatches `integration.auth.failed` to packages saved by that
same user that declare the topic. Every classified attempt emits. The platform
does not coalesce repeats; notifier packages decide how often to ping, typically
by pairing this topic with `integration.auth.succeeded` and storing last-known
health in package storage. Provider HTTP 5xx and missing connections do not
emit. Neither does a non-expiring grant (no refresh token and no access-token
expiry at connect): refresh returns `refreshed: false` and emits neither auth
topic.

Delivery is best-effort after the refresh caller error is classified — there is
no Queue / DLQ for this topic. Failures during subscriber discovery or
package-invocation infrastructure are logged and do not change the refresh error
the caller sees.

Handlers receive a metadata-first payload:

```ts
type IntegrationAuthFailedEvent = {
	event: 'integration.auth.failed'
	event_id: string
	integration: {
		name: string
		lane: 'user' | 'platform'
		account_label: string | null
		description: string | null
		provider: string | null
		platform_app_slug: string | null
		scopes: Array<string>
		connected_at: string | null
		token_refreshed_at: string | null
	}
	reason:
		| 'missing_refresh_token'
		| 'provider_rejected'
		| 'missing_secret'
		| 'host_not_approved'
		| 'invalid_config'
	provider: {
		error: string | null
		error_description: string | null
		http_status: number | null
	}
	reconnect_url: string
	account_url: string
	occurred_at: string
}
```

`reconnect_url` is built from the trusted deployment origin and links to
`/connect/oauth?provider=<name>`. When `account_label` looks like an email it
also adds `loginHint` so Google/OIDC can preselect that account. `account_url`
is the connection detail page (`/@<slug>/-/integrations/<name>`). The event
deliberately omits token values, secret values, client secrets, and secret
names. A short-lived access token that refreshes cleanly never emits. Successful
Google refreshes persist `userinfo.email` onto an empty `account_label` so later
reconnect pings can name the account.

Use this topic for notifier packages that post to Discord, email, or otherwise
ask the owner to reconnect a dead grant.

## `integration.auth.succeeded`

When host-side OAuth token refresh persists a new access token, or
`/connect/oauth` finishes saving tokens for a connection, Kody dispatches
`integration.auth.succeeded` to packages saved by that same user that declare
the topic. Every successful refresh and every successful connect persist emits.
Sequential attempts are not coalesced; concurrent in-flight refreshes of the
same connection share one attempt. The platform does not track working ↔ failed
itself; notifier packages store that edge in package storage so a later failure
can notify only on the working → failed transition.

Delivery is best-effort after the tokens are written. Failures during subscriber
discovery or package-invocation infrastructure are logged and do not change the
refresh result or the connect response.

Handlers receive a metadata-first payload:

```ts
type IntegrationAuthSucceededEvent = {
	event: 'integration.auth.succeeded'
	event_id: string
	integration: {
		name: string
		lane: 'user' | 'platform'
		account_label: string | null
		description: string | null
		provider: string | null
		platform_app_slug: string | null
		scopes: Array<string>
		connected_at: string | null
		token_refreshed_at: string | null
	}
	source: 'refresh' | 'oauth_connect'
	account_url: string
	occurred_at: string
}
```

`source` is `refresh` for `refreshIntegrationTokens` and `oauth_connect` for the
`/connect/oauth` persist path. `account_url` is built from the trusted
deployment origin and links to `/@<slug>/-/integrations/<name>`. The event
deliberately omits token values, secret values, client secrets, and secret
names.

Use this topic with `integration.auth.failed` to flip stored health back to
working after a reconnect, or to send an all-clear.

## `mcp.server.disconnected` / `mcp.server.reconnected`

When a saved, enabled outbound MCP server leaves `ready` and stays unavailable
after the hub's lightweight reconnect (two `connectToServer` + discover
attempts, no OAuth restart), Kody dispatches `mcp.server.disconnected` to
packages saved by that same user that declare the topic. When that down episode
later observes `ready` again, Kody dispatches `mcp.server.reconnected` with the
same `server.episode_id`.

Never-ready servers (still `authenticating` after add, with no stored tokens and
no token-recovery `last_error`), disabled servers, and in-flight `connecting` /
`connected` / `discovering` states do not emit. A durable token-recovery park
(`authenticating` plus “no refresh token” / phase token exchange) is a working →
failed flip: the hub infers previously-ready when the episode bit is missing,
stamps `last_error`, and queues `mcp.server.disconnected` without the
lightweight retry. Waiting and search peeks, account-page snapshots, and hub
mutations dispatch that pending event to same-user packages that declare the
topic (for example a Discord notifier). Those requests pass `waitUntil` so the
package invoke can finish after the response; the hub acks only the dispatched
event ids after fan-out returns complete. Incomplete discovery, retryable invoke
failures, and a failed enabled-server lookup leave the event pending instead of
acking it. `mcpServerReconnect` tries stored refresh first, then mints a new
authorization URL; listener packages should not call it on every event.

Delivery is best-effort after the hub observes the transition — there is no
Queue / DLQ for these topics. Failures during subscriber discovery or
package-invocation infrastructure are logged and do not fail the MCP tool call
or snapshot that noticed the change.

Handlers receive a metadata-first payload:

```ts
type McpServerConnectionEvent = {
	event: 'mcp.server.disconnected' | 'mcp.server.reconnected'
	event_id: string
	server: {
		id: string
		name: string
		state: string
		previous_state: string
		episode_id: string
	}
	observed_at: string
	account_url: string
}
```

`account_url` is built from the trusted deployment origin and links to
`/@<slug>/-/mcp-servers/<id>`. The event omits server URLs, OAuth tokens, bearer
headers, auth URLs, and discovered tool lists. Fetch live status with
`mcpServerList` when needed. Idempotency keys include the topic, episode id, and
subscriber package id, so one disconnected and one reconnected invoke per
episode.

Use these topics for notifier packages that post to Discord or otherwise tell
the owner an MCP server (for example `home`) dropped or came back. Do not scrape
run-error strings for connection health.

## `repo.pushed`

When Cloudflare Artifacts reports commits pushed to a Kody-managed Artifacts
repo (plain repo or package), Kody dispatches `repo.pushed` to packages saved by
that same user that declare the topic. Delivery is durable via the
`kody-artifacts-repo-events` Queue (with DLQ). Session fork repos, session
workspace branch pushes (`sessions/<id>`), and publish git-notes
(`refs/notes/commits`) never emit. Opening a repo session git-pushes the session
ref, and delivering it as `repo.pushed` would let a handler that opens another
session loop. Publish attaches a metadata note after the source-branch push;
that second git update is not a content push. Events for other
`ARTIFACTS_NAMESPACE` values are ignored. Handlers that only care about default
branch content should still check `push.ref`.

Handlers receive a metadata-first payload:

```ts
type RepoPushedEvent = {
	event: 'repo.pushed'
	repo: {
		source_id: string
		repo_id: string
		entity_kind: 'repo' | 'package'
		entity_id: string
		name: string | null
		kody_id: string | null
	}
	push: {
		ref: string
		before: string
		after: string
		total_commits_count: number
		commits_truncated: boolean
		commits: Array<{
			id: string
			message: string
			message_truncated: boolean
			timestamp: string
			author: { name: string; email: string }
			committer: { name: string; email: string }
			parents: Array<string>
		}>
	}
	artifacts: {
		namespace: string
		event_timestamp: string
		event_subscription_id: string
	}
}
```

`repo_id` is the Artifacts repo name (also stored on `entity_sources.repo_id`).
`name` is the user-facing plain-repo name or package npm name when known; The
package name leaf is set for packages. For `entity_kind: 'package'`, a push
updates live HEAD but does not mean the package published commit advanced — use
publish / external-push / reconcile for activation.

Idempotency keys include the after commit, ref, and subscriber package id, so
Queue redelivery is safe.

## `repo.created` / `repo.deleted`

Account-level Artifacts create/delete events map to `repo.created` and
`repo.deleted` with the same `repo` entity block plus Artifacts metadata
(`default_branch`, `description`, Cloudflare `cloudflare_repo_id`). Same-user
fan-out and Queue delivery match `repo.pushed`. Unmatched deletes (D1 row
already gone) are acknowledged without retry.

## `follow.published`

`follow.published` fires when a package's live version moves: `published_commit`
advanced. Followers of that package who still have create-level access receive
the event on packages in **their** org that declare the topic. Filters narrow
which of those handlers run; a filter never grants a topic the manifest does not
declare.

Anyone signed in can follow a public package (`is_private = 0`). A private
package requires `package:read` on that package (a `use` grant includes read;
`package:execute` alone does not). Losing that access pauses the follow. At zero
credits the handler is skipped, the skip is stored on the follow, and nothing is
queued.

```ts
type FollowPublishedEvent = {
	event: 'follow.published'
	event_id: string
	target: { kind: 'package'; name: string }
	previous_commit: string | null
	published_commit: string
	published_at: string
}
```

`target.name` is `@handle/name`. The payload does not include internal ids.
Create, list, and remove follows with `followAdd` / `followList` /
`followRemove` (`kody follow add` / `kody follow list` on the CLI), or with
**Follow** on the package or repo page. Each follow chooses its events
(`published`, `pushed`, or both); a follow only delivers the events it chose.
The workspace's Follows page (`/@<slug>/-/follows`) lists them with status and
pause reason. See the
[follow CLI contract](../contributing/contracts/follow-cli.md).

## `follow.pushed`

`follow.pushed` fires when the target's default branch moves. Pushes inside a
five-minute window collapse into one pending record (one row per target) and
flush on the scheduled follow-maintenance lane. Each event carries at most 20
commits; `push.commits_truncated` is true when `total_commits_count` is larger.

Push delivery is stricter than create. A package follow also needs
`package:read` on that package. A plain-repo follow needs org-wide
`package:read` in the owner org. A package grant is not enough for a repo, and a
grant preset name is never the check. If the follow exists but push is not
allowed, the push is skipped and the follow stays active so `follow.published`
can still fire. Owners cannot turn push follows off.

```ts
type FollowPushedEvent = {
	event: 'follow.pushed'
	event_id: string
	target: { kind: 'package' | 'repo'; name: string }
	push: {
		ref: string
		before: string | null
		after: string | null
		commits: Array<{
			id: string
			message: string
			message_truncated: boolean
			timestamp: string
			author: { name: string; email: string }
			committer: { name: string; email: string }
			parents: Array<string>
		}>
		total_commits_count: number
		commits_truncated: boolean
	}
	window_started_at: string
}
```

## `community.fork.upstream_updated`

When a public package you forked is republished and the listing pin moves, Kody
delivers `community.fork.upstream_updated` to packages saved by the forking
account that declare the topic. The event is a compatibility alias emitted from
the follow pipeline in the same turn as `follow.published`, with the payload
shape below. Emission walks every fork of the listing that is still behind the
new pin (forking the same listing twice produces two events). A paused follow
still leaves those fork subscribers receiving the alias. Republishes that keep
the same pinned commit do not emit, and forks already at the new pinned commit
are skipped. Forking the listing also follows the upstream package for the org
the fork landed in (the forker's personal org, or the active org when the fork
is made into a team org). Watching a public package without forking it is
supported: `followAdd` on `@handle/name` delivers `follow.published` (and
`follow.pushed` when you can read the target). The alias itself still requires a
fork, because its payload names that fork.

The alias runs on the follow publish path. Subscriber discovery and invocation
failures are logged and do not fail the publish. Idempotency keys include the
listing id, the new pinned commit, the fork id, and the subscriber package id,
so a repeated notify replays stored results instead of re-running handlers.

Handlers receive a metadata-only payload:

```ts
type CommunityForkUpstreamUpdatedEvent = {
	event: 'community.fork.upstream_updated'
	event_id: string
	listing: {
		id: string
		name: string
		kody_id: string
		public_url: string
	}
	publisher: {
		username: string | null
	}
	fork: {
		id: string
		package_id: string
		kody_id: string
		origin_commit: string
		forked_at: string
	}
	previous: { pinned_commit: string; package_version: string | null }
	current: { pinned_commit: string; package_version: string | null }
	published_at: string
}
```

`fork.package_id` and `fork.kody_id` identify your forked package (it may still
be an inert fork with no live saved package). `fork.origin_commit` is the
listing commit your fork last absorbed. `previous` and `current` are the
listing's pinned commit and author-supplied `package.json#version` before and
after the republish. `listing` and `publisher` are read when the event is
delivered, so if the listing republished again before delivery they describe the
newer release; key rebase logic on `current.pinned_commit`. The event omits
listing source and the publisher's account identifiers. Read upstream files from
`listing.public_url` or the community capabilities. When your changes are
ported, publish with `repoPublishSession` and `absorbed_upstream_commit` (see
[Community packages](../use/community-packages.md)).

Use this topic for packages that auto-rebase a fork, open a review session, or
post a Discord ping when an upstream package changes.

## `package.codemod.applied`

After a successful package codemod **apply**, Kody dispatches
`package.codemod.applied` to packages saved by the **owning user** of the
migrated package that declare the topic. Delivery follows the same best-effort
host dispatch path as `run.error.recorded` — there is no Queue / DLQ for this
topic. Failures during subscriber discovery or package-invocation infrastructure
are logged and do not fail the codemod apply.

Handlers receive a metadata-first payload:

```ts
type PackageCodemodSubscriptionEnvelope = {
	event: 'package.codemod.applied'
	codemod: {
		id: string
		description: string
	}
	package: {
		package_id: string
		kody_id: string
	}
	run: {
		run_id: string
		item_id: string
	}
	changed_paths: Array<string>
	before_commit: string | null
	after_commit: string | null
}
```

`changed_paths` lists published-tree paths the codemod transform modified.
`before_commit` and `after_commit` are the package's published commit before and
after apply. The event deliberately omits file contents — fetch the current
published source with repo or package capabilities when a handler needs diffs or
full files. Apply does not rewrite community listing snapshots; only the owning
saved package advances. `run.item_id` is the apply ledger item id.

Use this topic for notifier packages that record migrations, ping owners, or
trigger follow-up automation when platform codemods rewrite user package source.

## `package.codemod.reverted`

After a successful package codemod **revert**, Kody dispatches
`package.codemod.reverted` to packages saved by the **owning user** of the
restored package that declare the topic. Delivery semantics match
`package.codemod.applied` and `run.error.recorded`.

Handlers receive the same envelope shape with
`event: 'package.codemod.reverted'`:

```ts
type PackageCodemodSubscriptionEnvelope = {
	event: 'package.codemod.reverted'
	codemod: {
		id: string
		description: string
	}
	package: {
		package_id: string
		kody_id: string
	}
	run: {
		run_id: string
		item_id: string
	}
	changed_paths: Array<string>
	before_commit: string | null
	after_commit: string | null
}
```

For revert, `before_commit` is the post-codemod published commit (the source
apply item's `afterCommit`) and `after_commit` is the restored pre-codemod
commit. `changed_paths` is copied from the source apply item (paths the codemod
originally changed), not recomputed at revert time. `run.item_id` is the new
revert-run ledger item id. Revert snapshots expire from KV after 90 days, so
revert and this event are unavailable once the snapshot is gone.

Use this topic when automation must react to an operator or user undoing a prior
codemod apply.
