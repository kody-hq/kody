---
id: agent_inbox
title: Agent inbox
summary:
  Homepage email example: every account has a platform inbox, inbound mail
  emits email.message.received, and a package can wake work from a plus-tag
  without a model reading the mailbox. Load this when someone asks how Agent
  inbox works or how to treat email as a trigger.
category: platform
---

# Agent inbox

The homepage **Trigger it** card labeled Email is this example. Every Kody
account already has an address. Mail that arrives there is stored and emits
`email.message.received`. "Forward it to Kody" is a valid trigger for people and
systems that can send email but cannot call an API.

The inbox is a door into a package you own. Conversations stay with your agent,
and a package can wake that agent when a message needs one, the way Kent's
grok-bot does below. To give people a familiar chat surface for your agent, see
[Text your agent](./text-your-agent.md).

Watch:
[Kody Improves itself from your feedback](https://www.youtube.com/watch?v=QYOTz0P33tY)
for one inbox that wakes an agent from mail.

Live public behavior:
[`@kentcdodds/grok-bot`](https://kody.codes/@kentcdodds/grok-bot)
`./handle-email-message-received`. Mail to `kentcdodds+patch@inbox.kody.codes`
wakes that bot with a thread briefing. Cold mail from strangers is ignored.
Unaliased mail returns `{ handled: false }` so another subscriber can still run.

The storage contract is [Email primitives](../use/email-primitives.md). The
event contract is [Subscriptions and events](./package-subscriptions.md).

## The address

- Default inbox: `{username}@<platform domain>`. On production that is
  `{username}@inbox.kody.codes`.
- Plus-tags work: `{username}+invoices@inbox.kody.codes` and
  `{username}+patch@inbox.kody.codes` both land in `{username}`'s inbox. The
  full tagged address is preserved on the stored message, so a handler can
  dispatch on the tag.
- The inbox is provisioned automatically. There is nothing to create.
- `emailSend` from a job or export only mails verified destinations on the
  account. The From address is always `{username}@<platform domain>`.

Forward a thread, mail a plus-tag from a form, or BCC the inbox from a system
that already speaks SMTP. Kody stores the message, then subscribers run.

## Package shape

Subscribe in `package.json#kody.subscriptions`:

```json
{
	"name": "@you/inbox-router",
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Route stored inbound mail by plus-tag."
			}
		}
	}
}
```

The handler receives metadata, not the full body:

```ts
type EmailMessageReceivedEvent = {
	event: 'email.message.received'
	message: {
		id: string
		from_address: string | null
		to_addresses: Array<string>
		subject: string | null
	}
}

export default async function onEmailMessageReceived(
	event: EmailMessageReceivedEvent,
) {
	const to = event.message.to_addresses.join(',')
	if (!to.includes('+patch@')) return { handled: false }
	// Fetch the body only when this tag should act.
	return { handled: true, messageId: event.message.id }
}
```

Call `emailMessageGet` (or the package runtime `email` helper) only when the tag
or sender says the message is yours to handle. Do not pull every body on every
delivery.

After publish, smoke-test from interactive MCP with
`packageSubscriptionDispatch`:

```json
{
	"kody_id": "@you/inbox-router",
	"topic": "email.message.received",
	"email_message_id": "00000000000000000000000000000001"
}
```

Replay uses a stored inbound id. Fixture `params` are for synthetic envelopes.
Pass exactly one of `params` or `email_message_id`.

Kent's grok-bot handler:

- Wakes on `you+patch@…` when Kent is on the thread (From Kent, Kent on To/Cc,
  or a later reply on an opened thread).
- Ignores cold mail from strangers.
- Returns `{ handled: false }` for unaliased mail so the Discord inbox
  subscriber still runs.
- Accepts `{ dryRun: true }` so you can prove routing without a wake.

## Example prompts

**Build one**

> Search Kody for agent inbox and email.message.received. I want a package that
> watches my Kody inbox and only handles mail to
> `{my-username}+todo@inbox.kody.codes`. On a match, store a one-line summary
> and mail me a notify-self note. Ignore everything else. After publish,
> smoke-test with packageSubscriptionDispatch on one stored message.

**Wire a plus-tag to an existing agent**

> Look at https://kody.codes/@kentcdodds/grok-bot and the
> `./handle-email-message-received` export. I want the same plus-tag wake on my
> account: mail to `{my-username}+patch@inbox.kody.codes` should brief my
> connected agent. Do not invent a "chat with Kody" inbox.

**Prove it from chat**

> Import `kody:@kentcdodds/grok-bot/handle-email-message-received` with
> `{ dryRun: true, message: { from_address: "me@example.com", to_addresses: ["me+patch@inbox.kody.codes"], subject: "Fwd: please look" } }`
> only if that package is already mine. Otherwise fork first. Show me the
> routing decision.

## What you see

| Surface                      | What it is for                                                        |
| ---------------------------- | --------------------------------------------------------------------- |
| `{you}@inbox.kody.codes`     | The address you give other people and systems                         |
| `{you}+tag@inbox.kody.codes` | The same inbox, with a tag the handler can branch on                  |
| `/@<slug>/-/email`           | Stored inbound and outbound copies, destinations, sender rules        |
| `/@<slug>/-/activity`        | Subscription runs for `email.message.received`                        |
| Chat (`execute`)             | `emailMessageSearch` / `emailMessageGet`, or a dry-run of the handler |

The homepage card is a tile with the kicker **Email** and the title **Agent
inbox**. It links here.

## Where to go next

- [Email primitives](../use/email-primitives.md) — addressing, plus-tags,
  quotas, `emailSend` / `emailReply`. `emailReply` will not answer quarantined
  mail until you release it.
- [Subscriptions and events](./package-subscriptions.md) — payload shape and
  synthetic dispatch.
- [Email and memories](./first-win.md) — optional welcome-email loop. That
  playbook does not create packages.
- [Purchase thanks](./purchase-thanks.md) — the event sibling on the same
  homepage row.
