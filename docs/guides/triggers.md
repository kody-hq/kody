---
id: triggers
title: Jobs, workflows, and webhooks
summary:
  How work runs when nobody is in the chat. Package-owned jobs for recurring
  schedules, workflows for deferred or long one-shot runs, inbound webhooks for
  provider events, subscriptions for events inside Kody, and the inbox — which
  to pick, how each is declared, and how to test one safely before enabling it.
  Load this when someone asks how to run something later, on a schedule, or when
  a provider knocks.
category: platform
---

# Jobs, workflows, and webhooks

Everything your agent builds in Kody can run without the agent. That is the
difference between an automation and a chat transcript. Kody has four ways to
start work when nobody is typing, and every one of them runs a package you own —
no model in the loop, no tokens spent.

| You want to run…                                      | Use                    |
| ----------------------------------------------------- | ---------------------- |
| The same thing on a schedule                          | a **job**              |
| One thing later, or something longer than a request   | a **workflow**         |
| Something when Sentry, GitHub, Stripe, or a CLI POSTs | an inbound **webhook** |
| Something when Kody itself emits an event             | a **subscription**     |

Prefer the event that actually describes the moment — a webhook or a
subscription — and reach for a schedule when no event exists. Cron is fine; it
is just not the hero.

> [!WATCH] https://www.youtube.com/watch?v=o5L5OprLhBg Watch: Kody fixes a
> Stripe webhook after a domain rename

Also watch:
[Shade automation from an INTENT.md — deterministic code, no model in the loop](https://www.youtube.com/watch?v=OZKDO9Pzmo0).

## Jobs — recurring schedules that travel with the package

A job is declared in the package manifest, so the schedule ships with the
behavior it runs:

```json
{
	"kody": {
		"jobs": {
			"daily-digest": {
				"entry": "./src/daily-digest.ts",
				"schedule": { "type": "cron", "expression": "0 8 * * *" },
				"timezone": "America/Denver",
				"enabled": false
			}
		}
	}
}
```

- The entry is a package-local module with no arguments. The usual shape is a
  thin wrapper that calls a callable export and sends notify-self mail only when
  there is something to say.
- Publish with `"enabled": false`, invoke the wrapper once from `execute` to
  prove it, then enable. A schedule you have never run once is a schedule you
  will debug at 8 a.m.
- Each run gets a job-scoped scratch bucket; shared durable state (cursors, the
  last seen id) belongs in `packageStorage()`.
- `jobUpdate` adjusts schedule, timezone, enabled state, params, and
  `expires_at`; `jobRunNow` fires one run for debugging. Name and source stay in
  the repo — change them there and publish.
- A job that is off carries `disabled_reason`: the `reason` passed to
  `jobUpdate` when someone turned it off (or how it was turned off when no
  reason was given), or what Kody did (it passed its expiry time, the scheduler
  could not compute the next run, its creator left the org). It is cleared when
  the job turns back on and shows as **Why it is off** on the job page.
- `enablementEnable` on a cron trigger also turns its job on when you hold
  `job:write`. Without it the enablement still turns on, the job stays off, and
  the result's `job` field says so (`state: "left_off"`,
  `missing_permission: "job:write"`) with how to get it: ask an Owner to grant
  `job:write` or to turn the job on.

Jobs do not hang off an integration or an MCP connection. If a "job" has no
package, save the package first. Runs show up on `/@<slug>/-/jobs`.

## Workflows — deferred and durable one-shot work

A workflow is a durable run Kody executes later, outside the request that asked
for it. Use one instead of plain `execute` for:

- **later** — `runAt` in the future ("remind me Friday", "retry after the
  window")
- **longer** — batch sweeps, migrations, polling loops, or steps that would
  exceed execute's ~90 second budget; workflow steps get a longer sandbox
- **once** — an `idempotencyKey` makes a repeated `create` return the existing
  run instead of starting a duplicate

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		exportName: './rebuild-index',
		runAt: new Date(Date.now() + 15 * 60_000),
		idempotencyKey: 'rebuild-index:2026-09-08',
		params: {},
	})
}
```

`workflows.create` takes either `code` (a complete module string) or
`exportName` (a saved-package export). Inspect runs with `workflowRunList`,
cancel with `workflowRunCancel`; they appear on `/@<slug>/-/workflows`. Unnamed
inline runs display as `inline-code` with the idempotency key as a subtitle.
Recurring work is a job, not a workflow that reschedules itself.

## Inbound webhooks — the external HTTP knock

A webhook gives a package a credentialed ingress URL (the credential stays out
of MCP tool output). A provider POSTs to it and Kody dispatches the validated
request to the package export that owns it.

1. Declare it under `package.json#kody.webhooks`: a `name`, the `export` it
   binds to, and `verification`. Use an HMAC type (header and encoding) when the
   sender signs, or `{ "type": "url-secret" }` when it cannot; then the URL
   secret is the only credential. A declared HMAC type never falls back to the
   URL secret. The [signing presets](../use/webhooks.md#signing-presets) list
   the block for Stripe, GitHub, Sentry, X, Bitbucket, your own callers, and the
   senders Kody cannot verify yet (Discord Ed25519, Slack, Telegram). Omit
   `secretName` for GitHub-style hooks so mint stores package-owned HMAC. Set
   `secretName` only for provider-issued secrets (Sentry, Stripe) and store that
   value with `secretSet`. Providers that quiz URL ownership (X CRC, WebSub,
   Meta, Slack) also declare `challenge`; the platform answers that quiz on the
   minted URL. One webhook name binds one export; there is no wildcard.
2. Mint a handle with `webhookUrlMint` (returns a `handle`, not the credential)
   and register it with `webhookUrlApply` (`type: "http"` with `{{webhookUrl}}`
   after the owner Approves the destination at `/connect/webhook-apply`; GitHub
   repo hooks use the same path against the Hooks API, with `{{webhookSecret}}`
   in `config.secret` when HMAC is declared). Treat the URL as a credential;
   tool output never includes it. When apply does not fit the provider, the
   owner copies the URL from the package's settings page
   (`/@<username>/<packageKodyId>/settings`, Webhooks section), where they can
   also reveal, rotate, disable, or enable it. Rotate keeps the previous URL
   live for 24 hours, or until the first accepted delivery arrives on the new
   URL. `/@<slug>/-/webhooks` lists every webhook across packages and links to
   those sections.

Declaring a webhook does not open ingress, and minting alone does not run
anything: until a person approves it, deliveries answer 409 `enablement_not_on`
with the approval link. `webhookUrlMint` returns that link as `approval_url`;
approving turns the webhook on for the approver and is where its credentials are
mapped. Deliveries are rate-limited per webhook (default 60 per minute, at most
600), and body-only HMAC is replayable unless you opt into a timestamp window or
delivery-id header. Full contract and payload shapes:
[Inbound webhooks](../use/webhooks.md).

Sentry noise, GitHub events, Stripe payments, a shortcut on your phone, a CLI on
your laptop — anything that can POST JSON can start a package this way.

## Subscriptions — events from inside Kody

When the trigger is something Kody already knows about — a message landing in
your inbox, a repo push, a run error, an integration losing auth — a package
subscribes to that topic in `package.json#kody.subscriptions` and Kody invokes
the handler with the event payload. After publish, smoke-test that handler from
interactive MCP with `packageSubscriptionDispatch`. Reuse another package with a
static `kody:@` import. Topics, payloads, and package-emitted events:
[Subscriptions and events](./package-subscriptions.md).

## The inbox is a trigger too

Every account has an email address. Mail that arrives there is stored and emits
`email.message.received`, so "forward it to Kody" is a valid trigger for people
and systems that can send email but cannot call an API. The same inbox is how a
job tells you it finished: `emailSend` mails the account's own address and
nothing else. See [Email primitives](../use/email-primitives.md).

## Turning triggers on in an org

In an org, a declared trigger runs only for the people who turned it on, and it
runs as them: their access, their bill, their audit trail. Publishing never
turns anything on.

- The approval page turns triggers on with one Approve, together with the
  credentials they use. `credentialMappingPropose` builds the link (`triggers`
  to map, `enable` to turn one on with no mapping). Minting a webhook URL never
  turns it on; the mint returns its approval link.
- After you approve an agent's link, that same agent can switch your trigger's
  credentials back to a value it proposed and you approved, with
  `credentialTriggerPickSet`. It cannot pick anything else or turn a trigger on:
  it has to propose again.
- `enablementEnable` turns a job (`cron`) or subscription topic on for you. For
  a cron job it also turns the job's own `enabled` flag on and schedules the
  next tick. You need execute access to the package. A webhook's first turn-on
  goes through Approve instead; `enablementEnable` refuses it with the approval
  link and only returns a webhook enablement that already exists. A webhook URL
  has at most one live enablement, so a second person's Approve is refused.
- `enablementList` shows yours (`scope: "mine"`); Owners can list the whole org
  (`scope: "org"`). `enablementDisable` turns one off. A webhook turned off this
  way answers 404; turn it back on by Approving the same URL again.
- If you lose access to the package, the org, or a credential the run uses, the
  enablement pauses and events are dropped. It resumes by itself on the next
  event once access is back.
- A credential your trigger's mapping names is checked before each run. If it is
  deleted, you lost Use on it, or a republish changed the need so it no longer
  fits, the enablement pauses instead of running; map another credential on the
  package's Credentials page (or get Use back) and the next event resumes it.
  Defaults are not checked this way: an unusable default falls through to the
  next layer.
- `jobRunNow` does not fire a scheduled run in an org; use `execute` to invoke
  the wrapper as yourself.

## Choosing well

- A schedule is optional, not the point. If the person cannot name a time they
  want something to happen, leave the trigger off and let them ask.
- Test before you enable: import the wrapper from `execute`, smoke-test a
  subscription from interactive MCP with `packageSubscriptionDispatch`, or
  smoke-test a minted webhook with `webhookSyntheticDispatch` (not the same as a
  package-local `dryRun` field on trusted-client POSTs).
- Keep the wrapper quiet. Notify only when there is news; an empty digest every
  morning trains people to ignore the real one.
- Failures and recent runs for every trigger live on `/@<slug>/-/activity`.

## Where to go next

- [Flake Hunter](./flake-hunter.md), [Sentry Issues](./sentry-issues.md),
  [Agent inbox](./agent-inbox.md), [Purchase thanks](./purchase-thanks.md) — the
  four homepage Trigger it cards as worked examples.
- [Package lifecycle](./package-lifecycle.md) — testing a scheduled wrapper
  before enabling its schedule.
- [How Kody works](./how-kody-works.md) — one loop from ad hoc question to a
  daily email that stays quiet until something ships.
- [Workflows](../use/workflows.md) — the full `workflows.create` reference.
