---
id: mcp_events
title: MCP Events from packages
summary:
  Opt a package topic into MCP Events so ChatGPT (and other webhook-capable MCP
  clients) can subscribe. Delivery reuses the same package event bus as
  kody.subscriptions. Behind the mcp-events-extension flag.
category: platform
audience: agents
---

# MCP Events from packages

MCP Events let a connected host subscribe to things your packages emit: a
Discord message, a checkout, a job finishing. They wake the agent when they
happen. Kody implements the **webhook-only** profile of the draft MCP Events
extension (design sketch 2026-02-19; OpenAI ChatGPT profile on protocol
`2026-07-28`). Poll and push delivery are out of scope.

This surface is behind the `mcp-events-extension` feature flag. Signed-in users
can turn it on from this page. Experimenters get it when operators enable the
flag for the experiments audience.

Package subscriptions between your own packages stay on
[Package subscriptions and events](./package-subscriptions.md). MCP Events is
the same bus exposed to an external MCP client.

## What you get

When the flag is on and the client signed in with OAuth (clients declare
nothing; the server advertises, as the OpenAI profile specifies):

1. `/mcp` advertises an `events` capability on `server/discover`.
2. The client can call `events/list`, `events/subscribe`, and
   `events/unsubscribe`.
3. Matching package `events.dispatch` calls POST a Standard Webhooks-signed
   payload to the client's callback URL.

The tool surface stays `search` / `execute` / `api`. Nothing is exposed by
default: each topic opts in with `"mcp": true` on its `kody.emits` entry.

## Clients that consume it

| Client                                                  | Support                                           |
| ------------------------------------------------------- | ------------------------------------------------- |
| ChatGPT (Work chats on web; desktop Work + Cloud; dots) | Webhook MCP Events on protocol `2026-07-28`       |
| Other MCP hosts                                         | Only if they implement webhook subscribe/delivery |

Hosts that do not implement events (Cursor and Claude today) still see the
`events` capability when the flag is on and ignore it. Non-OAuth callers and
callers with the flag off get no `events` capability, and `events/*` methods are
not registered.

## Opt a topic into MCP

Declare the topic in `package.json#kody.emits` as usual, and set `mcp: true`.
This example also declares a package app (`kody.app.entry`) because
`events.dispatch` runs only inside a package runtime:

```json
{
	"name": "@you/ping-notifier",
	"type": "module",
	"exports": {},
	"kody": {
		"description": "Emits a ping event an MCP host can subscribe to.",
		"app": {
			"entry": "./src/app.ts"
		},
		"emits": {
			"@you/ping.ready": {
				"description": "A ping was requested.",
				"mcp": true,
				"payloadSchema": {
					"type": "object",
					"properties": {
						"message": { "type": "string", "minLength": 1 }
					},
					"required": ["message"],
					"additionalProperties": false
				}
			}
		}
	}
}
```

Rules:

- Omit `mcp` or set `"mcp": false` to keep the topic package-internal (same-user
  `kody.subscriptions` deliver it).
- The MCP event **name** is the topic string (`@you/ping.ready`).
- Subscriptions take no filter arguments (`inputSchema` is an empty object).
- Payloads follow the package-event 64 KiB cap; MCP delivery allows up to 256
  KiB for the full webhook body.

## Emit

`events` is bound only in package apps, package jobs, and subscription handlers.
Ad hoc `execute` leaves it unbound, and statically importing a package export
from `execute` does not bind it, so do not dispatch from `execute`. Emit from
one of those runtimes instead. Here the app answers `POST /ping`:

```ts
import { events } from 'kody:runtime'

export default {
	async fetch(request: Request) {
		const url = new URL(request.url)
		if (request.method !== 'POST' || url.pathname !== '/ping') {
			return new Response('Not found', { status: 404 })
		}
		const body = (await request.json().catch(() => ({}))) as {
			message?: unknown
		}
		const message =
			typeof body.message === 'string' && body.message ? body.message : 'hello'
		const result = await events.dispatch({
			topic: '@you/ping.ready',
			idempotencyKey: `ping:${crypto.randomUUID()}`,
			payload: { message },
		})
		return Response.json(result)
	},
}
```

The same `events.dispatch` call works from a `kody.jobs` entry (run it once with
`jobRunNow`) or from a `kody.subscriptions` handler that re-emits another topic.
See [Package subscriptions and events](./package-subscriptions.md).

Dispatch stays asynchronous: validate → enqueue on
`kody-package-events-dispatch` → deliver to package subscribers **and** any
matching MCP subscriptions for the same user. There is no second dispatch path.

## Subscribe and delivery

1. The host calls `events/list` and sees only MCP-opted topics from packages the
   connection may read (connection-profile grants apply).
2. The host calls `events/subscribe` with the event name, a HTTPS callback URL,
   and a `whsec_…` signing secret.
3. Kody verifies the callback with a signed challenge, then stores the
   subscription (TTL default 1 hour, max 24 hours; refresh before expiry).
4. When your package dispatches, Kody POSTs one Standard Webhooks-signed event
   per subscription:

```http
POST /mcp-events/callback
Content-Type: application/json
webhook-id: evt_…
webhook-timestamp: 1739980800
webhook-signature: v1,…
X-MCP-Subscription-Id: sub_…

{
  "eventId": "evt_…",
  "name": "@you/ping.ready",
  "timestamp": "2026-10-07T12:00:00.000Z",
  "data": { "message": "hello" },
  "cursor": null
}
```

Subscriptions stop delivering when the OAuth client is revoked, the password
changes, or the TTL expires without refresh. Revoke and password-change paths
delete the rows immediately; an expired TTL only stops delivery until a later
`events/subscribe` from that principal prunes the stale row. Events never cross
accounts.

## Try it

1. Turn the flag on with the button on this page (or opt into experiments and
   wait for the experiments audience enable).
2. Publish the package above with `packageSave` (or push it through the git
   lane). Include a non-empty root `README.md` and `AGENTS.md`. `packageSave`
   rejects the package without them.
3. Connect ChatGPT (or another events-capable host) to your Kody MCP server with
   OAuth. Its `server/discover` includes `events: {}`, and `events/list` returns
   `@you/ping.ready`.
4. Ask the host to monitor `@you/ping.ready` and say what to do when it fires.
5. Trigger the app route. From `execute`, call `packageAppFetch` with the
   package id:

   ```json
   {
   	"package_id": "<your package id>",
   	"path": "/ping",
   	"method": "POST",
   	"headers": { "content-type": "application/json" },
   	"body": "{\"message\":\"hello\"}"
   }
   ```

   The response body is the dispatch result, for example
   `{"topic":"@you/ping.ready","status":"enqueued",...}`. The host receives a
   signed webhook for its subscription and wakes the agent.

Further reading: [Package subscriptions and events](./package-subscriptions.md),
[ADR 0059](../contributing/decisions/0059-mcp-events-extension-behind-flag.md),
[ADR 0087](../contributing/decisions/0087-mcp-events-no-client-declaration.md).
