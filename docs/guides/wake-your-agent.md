---
id: wake_your_agent
title: Wake your agent
summary:
  Recipe for waking a connected agent when something happens in Kody (a failed
  run, a package event, inbound mail). Lead with MCP Events when the MCP client
  supports the events extension (behind the mcp-events-extension flag; ChatGPT
  today). Otherwise use a package subscription or job that POSTs to the agent's
  webhook URL, or the email-wake pattern. Pick by what the client supports.
category: platform
audience: agents
---

# Wake your agent

Kody runs jobs, subscriptions, and webhooks while your agent is closed. To pull
the agent back in when one of them needs it, pick the path the agent's host
actually supports. A laptop agent with no wake path cannot be woken. Say so, and
offer to build the Kody half now.

## Pick a path

| Your MCP client or host                                         | Use                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| Advertises MCP Events (ChatGPT today)                           | [MCP Events](#mcp-events)                            |
| Has a wake or webhook URL (cloud agent API, bot gateway, CI)    | [Package POST to the webhook](#post-to-the-webhook)  |
| Reads mail, or a bridge turns mail into a message for the agent | [Email wake](#email-wake)                            |
| None of these                                                   | No wake. Tell the user; check Activity on next start |

Check before you choose. If `server/discover` on `/mcp` shows an `events`
capability, the client can use MCP Events. Kody only advertises `events` while
the `mcp-events-extension` flag is on, so if the capability is missing and the
client supports events, ask the user to turn the flag on before you fall back.
If you do not know whether the host has a wake URL, ask the user rather than
guessing.

## MCP Events

[MCP Events](./mcp-events.md) let the client subscribe to topics your packages
emit. Kody POSTs a signed event to the client's callback, and the client wakes
the agent. Nothing to host and no URL to store.

- The surface is behind the `mcp-events-extension` feature flag. The user turns
  it on from the MCP Events guide page on the website, or joins experiments.
- Supported clients: ChatGPT (Work chats on web, desktop Work + Cloud, dots) on
  protocol `2026-07-28`. Other hosts work only if they advertise events support
  and implement webhook subscribe and delivery. Cursor and Claude do not today.
- Opt a topic in with `"mcp": true` on its `package.json#kody.emits` entry, and
  `events.dispatch` it from the package. To surface a Kody topic such as
  `run.error.recorded`, subscribe a small package to it and re-emit an opted-in
  topic.

## POST to the webhook

For hosts that expose a wake URL, a package does the POST. Trigger it with a
subscription (`run.error.recorded`, a package-emitted topic,
`email.message.received`), an inbound webhook from an outside system (see
[Triggers](./triggers.md)), or a job on a schedule.

Store the full wake URL as a **URL** credential so the package never holds it.
Code passes an empty path to POST to the stored URL itself. If the host also
wants a bearer token, declare it as a separate Key need. Example: wake the agent
when a run fails.

```json
{
	"name": "@you/wake-on-error",
	"exports": { ".": "./src/index.ts" },
	"kody": {
		"description": "Wake my agent when a run fails.",
		"credentials": {
			"agent-wake": {
				"kind": "url",
				"description": "My agent's wake URL"
			}
		},
		"subscriptions": {
			"run.error.recorded": {
				"handler": "./src/on-run-error.ts",
				"description": "POST failed runs to my agent."
			}
		}
	}
}
```

```ts
import { credential } from 'kody:runtime'

export default async function onRunError(event: {
	run: { name: string | null; error_message: string | null }
	activity_url: string
}) {
	const wake = await credential('agent-wake')
	const response = await wake.fetch('', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			text: `Kody run ${event.run.name ?? ''} failed: ${event.run.error_message ?? ''}`,
			link: event.activity_url,
		}),
	})
	if (!response.ok) throw new Error(`Wake POST failed: ${response.status}`)
	return { handled: true }
}
```

`run.error.recorded` is best-effort, and failed subscription handlers (this one
included) never emit it, so treat the wake as a nudge, not a guarantee. Send the
agent the `activity_url` and a one-line reason, not logs. The agent can call
`runGet` when it wakes. Payload fields are in
[Package subscriptions](./package-subscriptions.md#runerrorrecorded).

## Email wake

Every account has an inbox (`{username}@inbox.kody.codes`) and plus-tags route
on it. A subscription on `email.message.received` can wake the agent from a
tagged message, or mail a host that wakes on email. See
[Agent inbox](./agent-inbox.md) for the plus-tag pattern and a live example.

## Where to go next

- [MCP Events](./mcp-events.md): flag, topic opt-in, delivery.
- [Package subscriptions](./package-subscriptions.md): every Kody topic.
- [Credentials](./credentials.md#url): URL and Key credentials.
- [Agent inbox](./agent-inbox.md): email triggers.
