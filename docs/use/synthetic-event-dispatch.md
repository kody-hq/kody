# Synthetic event dispatch

`packageSubscriptionDispatch` is the **interactive MCP** smoke test for **one**
declared `package.json#kody.subscriptions` handler on an **owner-scoped** saved
package. Call it after publish to verify wiring without waiting for a real
platform event. It is a **platform-marked real-surface** `subscription` run
(`packageStorage()`, secrets, `kody:runtime`). **Side effects are real.**

It targets only the package you name. It does not fan out to other subscribers
and does not enqueue production Queue delivery.

Package reuse is a static `import … from 'kody:@scope/pkg/export'` (declare
`kody.dependencies`). When the name is data, use computed `import(specifier)`
for a caller-owned or forked module. Exactly-once work uses
[workflows](./workflows.md). External clients use
[inbound webhooks](./webhooks.md). Another package's secret mounts and
`packageContext` apply when that package is the run — its job, subscription,
webhook, or app.

The platform sets top-level envelope fields `synthetic: true` and, for
stored-mail replay, `replay_of`. Real event dispatch strips caller-supplied
`synthetic` and `replay_of` from handler envelopes; callers cannot forge those
fields on synthetic MCP calls either. Run records agree with the handler
payload. Handlers treat synthetic events identically to production unless a
deliberately visible irreversible-side-effect guard says otherwise.

## When to use it

- From an interactive MCP agent after `packagePublishExternalPush` when the
  package declares subscriptions and `test_hints` includes topic snippets
- To debug that same package's handler logic with a minimal fixture payload
- To replay a stored inbound message with `email_message_id`
- Together with [Package app fetch](./package-app-fetch.md) as part of
  post-publish verification

For inbound webhooks, use `webhookSyntheticDispatch` after mint (see
[Inbound webhooks — Synthetic smoke test](./webhooks.md#synthetic-smoke-test)).
That capability is the webhook sibling of this subscription smoke test — not a
package-local `dryRun` field.

Use `packageSubscriptionsList` first to confirm the topic and handler path. Use
real platform events for end-to-end delivery, admin-role gates, filters, and
multi-package fan-out. Reuse another package from a job or subscription with a
static `kody:@` import — see [Package reuse](./packages.md#package-reuse).

## Call shape

Search the `packages` domain, then call `packageSubscriptionDispatch`:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "email.message.received",
	"params": {}
}
```

Fields:

| Field              | Required | Meaning                                                                |
| ------------------ | -------- | ---------------------------------------------------------------------- |
| scoped name        | one of   | `@owner/leaf` (or the name leaf) as `kody_id`                          |
| `package_id`       | one of   | Saved-package UUID when the scoped name is not known                   |
| `topic`            | yes      | Exact topic key from `kody.subscriptions`                              |
| `params`           | one of   | Handler input fixture — use `{}` only when the handler tolerates empty |
| `email_message_id` | one of   | Stored inbound message id; platform rebuilds the production envelope   |

Pass exactly **one** of `params` or `email_message_id`, not both. There is no
top-level request `idempotency_key` — the platform generates it. A
package-emitted event fixture can still include its production
`params.idempotency_key` inside the nested event envelope.

Look up the package with the scoped `@owner/leaf` name (or `package_id` when the
name is not known). The lookup runs in the org the connection is bound to.

### Fixture input (`params`)

`params` is the object merged into the handler envelope (before the platform
adds `synthetic: true`). Shape depends on the topic:

- **Platform-owned topics** (`email.message.received`, `run.error.recorded`,
  `integration.auth.failed`, `repo.pushed`, …) — use the metadata-first payloads
  documented in the
  [package subscriptions guide](../guides/package-subscriptions.md). Include
  only fields your handler reads.
- **Package-emitted topics** (`@scope/topic.name`) — use the
  `PackageEventEnvelope` shape (`event`, `source`, `idempotency_key`,
  `payload`). Synthetic dispatch does not validate against the emitter's
  `kody.emits` schema; supply a fixture `source` block when the handler depends
  on it.

Example minimal `run.error.recorded` fixture:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "run.error.recorded",
	"params": {
		"event": "run.error.recorded",
		"run": {
			"id": "00000000000000000000000000000001",
			"surface": "job",
			"name": "smoke",
			"package_id": null,
			"kody_id": null,
			"source_id": null,
			"published_commit": null,
			"storage_id": null,
			"job_id": null,
			"workflow_id": null,
			"invocation_id": null,
			"session_id": null,
			"parent_run_id": null,
			"started_at": "2026-08-08T12:00:00.000Z",
			"finished_at": "2026-08-08T12:00:01.000Z",
			"duration_ms": 1000,
			"error_name": "Error",
			"error_message": "Synthetic smoke failure"
		},
		"activity_url": "https://kody.codes/@<slug>/-/activity/00000000000000000000000000000001"
	}
}
```

Example minimal `integration.auth.failed` fixture:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "integration.auth.failed",
	"params": {
		"event": "integration.auth.failed",
		"event_id": "00000000-0000-4000-8000-000000000001",
		"integration": {
			"name": "google",
			"lane": "user",
			"account_label": "kent.c.dodds@gmail.com",
			"description": null,
			"provider": "google",
			"platform_app_slug": null,
			"scopes": ["openid", "email", "https://www.googleapis.com/auth/calendar"],
			"connected_at": "2026-01-01T00:00:00.000Z",
			"token_refreshed_at": "2026-08-01T00:00:00.000Z"
		},
		"reason": "provider_rejected",
		"provider": {
			"error": "invalid_grant",
			"error_description": "Token has been expired or revoked.",
			"http_status": 400
		},
		"reconnect_url": "https://kody.codes/connect/oauth?provider=google&loginHint=kent.c.dodds%40gmail.com",
		"account_url": "https://kody.codes/@<slug>/-/integrations/google",
		"occurred_at": "2026-08-18T17:00:00.000Z"
	}
}
```

Example minimal `integration.auth.succeeded` fixture:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "integration.auth.succeeded",
	"params": {
		"event": "integration.auth.succeeded",
		"event_id": "00000000-0000-4000-8000-000000000002",
		"integration": {
			"name": "google",
			"lane": "platform",
			"account_label": null,
			"provider": "google",
			"platform_app_slug": "google"
		},
		"source": "oauth_connect",
		"account_url": "https://kody.codes/@<slug>/-/integrations/google",
		"occurred_at": "2026-08-18T18:00:00.000Z"
	}
}
```

Example minimal `mcp.server.disconnected` fixture:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "mcp.server.disconnected",
	"params": {
		"event": "mcp.server.disconnected",
		"event_id": "00000000-0000-4000-8000-000000000001",
		"server": {
			"id": "00000000-0000-4000-8000-000000000002",
			"name": "home",
			"state": "disconnected",
			"previous_state": "ready",
			"episode_id": "00000000-0000-4000-8000-000000000003"
		},
		"observed_at": "2026-08-18T17:54:07.000Z",
		"account_url": "https://kody.codes/@<slug>/-/mcp-servers/00000000-0000-4000-8000-000000000002"
	}
}
```

### Stored-mail replay (`email_message_id`)

For email topics, pass a stored message id instead of hand-building metadata:

```json
{
	"kody_id": "@owner/email-automation",
	"topic": "email.message.received",
	"email_message_id": "00000000000000000000000000000001"
}
```

The platform rebuilds the stored inbound email envelope from D1, sets
`synthetic: true`, and sets `replay_of` to the message id. The handler sees the
same shape as production dispatch for that message.

## Response and Activity

Successful invocations return the handler's JSON-serializable result (when the
handler returns one). Handler throws and non-2xx infrastructure failures surface
as structured MCP errors. Check [Activity](./activity.md) (`subscription`
surface) for run records; the run record includes `synthetic: true` (and
`replay_of` when applicable). Subscription-handler failures do **not** emit
`run.error.recorded` (recursion guard).

## Semantics

- Requires a published subscription handler bundle for the topic.
- Ignores subscription `filters` — synthetic dispatch always targets the named
  package; supply matching fields inside `params` when testing filter-dependent
  logic.
- Admin-only delivery rules (for example `platform.feedback.submitted`,
  `status.incident.opened`, `fleet.package_error_rate.elevated`,
  `fleet.package_owner_error_spike`, `fleet.users_affected.elevated`,
  `fleet.users_affected.resolved`, `fleet.entitlement.crossed`,
  `auth.denial.burst`, `email.delivery.burst`, `user.created`, `user.deleted`,
  `user.email_verification.failed`, `user.email_verification.stalled`,
  `user.email_outbound.paused`, or `email.system-message.sent`) apply to
  **production** fan-out only; synthetic dispatch runs your handler directly for
  smoke testing.
- Side effects (`packageStorage()`, outbound APIs, downstream invokes) are real.
  Use a deliberately visible irreversible-side-effect guard when smoke tests
  should stay safe.

## Related

- [Packages](./packages.md) — subscription manifest shape and
  [package reuse](./packages.md#package-reuse)
- [Package app fetch](./package-app-fetch.md) — app handler smoke tests
- [Package subscriptions guide](../guides/package-subscriptions.md) — topic
  payloads and production delivery semantics
- [Package authoring guide](../guides/package-authoring.md#verify-your-publish)
- Decision:
  [Synthetic package requests](../contributing/decisions/0013-synthetic-package-requests.md)
