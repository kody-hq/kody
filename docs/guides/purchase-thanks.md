---
id: purchase_thanks
title: Purchase thanks
summary:
  Homepage event example: a verified purchase becomes a fact your factory
  already knows, and a package drafts a thank-you without anyone typing.
  Load this when someone asks how Purchase thanks works or how to react to
  an event Kody (or a package you own) already emitted.
category: platform
---

# Purchase thanks

The homepage **Trigger it** card labeled Event is this example. A purchase is a
moment your factory can already know about. The package that reacts does not
need a model in the loop and does not need you to paste the receipt into chat.

Live public package:
[`@kentcdodds/stripe-purchase-thanks`](https://kody.codes/@kentcdodds/stripe-purchase-thanks).
After a verified successful Stripe checkout it indexes Kent's business Gmail for
the buyer, creates a thank-you draft on a relevant thread (To is the buyer,
never Kent), and posts a one-liner that the draft is ready. Draft only. Never
send.

The homepage calls this an **event** because the interesting fact is the
purchase, not the HTTP door. Kent's public package uses a Stripe webhook as the
way that fact arrives, then treats the verified checkout as the event that
starts the thank-you. You can also emit `@you/purchase.completed` from one
package and subscribe from another.

Subscriptions and package-emitted topics:
[Subscriptions and events](./package-subscriptions.md). Vendor POST ingress:
[Inbound webhooks](../use/webhooks.md). Drafts the agent must not send:
[Gmail drafts without send](./locked-gmail-drafts.md).

## Two honest shapes

**One package, vendor ingress.** Stripe POSTs `checkout.session.completed`. The
handler fetch-back verifies the event id (the body is untrusted; only `id` is
used), keeps successful paid checkouts, and calls `thankPurchase`. That is
Kent's public package.

```ts
import handleStripeWebhook from 'kody:@you/stripe-purchase-thanks/handle-stripe-webhook'

export default async function main() {
	return await handleStripeWebhook({
		request: { json: { id: 'evt_1ABC', type: 'checkout.session.completed' } },
	})
}
```

**Two packages, an owned topic.** The Stripe (or commerce) package verifies the
payment, then emits. The thanks package subscribes. Other packages can listen
without sharing the webhook secret.

```ts
import { events } from 'kody:runtime'

await events.dispatch({
	topic: '@you/purchase.completed',
	idempotencyKey: `stripe:checkout:${eventId}`,
	payload: {
		eventId,
		product: 'Kody Standard',
		customerEmail: 'ada@example.com',
	},
})
```

```json
{
	"name": "@you/purchase-thanks",
	"kody": {
		"subscriptions": {
			"@you/purchase.completed": {
				"handler": "./src/on-purchase-completed.ts",
				"description": "Draft a thank-you after a verified purchase."
			}
		}
	}
}
```

Emit from any of the commerce package's code: a job, export, subscription
handler, webhook handler, or app, including an export you call from `execute`.
An ad hoc `execute` snippet outside any package cannot emit. Payloads are JSON
objects capped at 64 KiB. Store Gmail threads and draft ids in
`packageStorage()` and emit a reference when the thank-you record is large.

## Package shape

Kent's thank-you export is the part you replay from chat after a payment is
already verified:

```ts
import { thankPurchase } from 'kody:@you/stripe-purchase-thanks/thank-purchase'

export default async function main() {
	return await thankPurchase({
		eventId: 'evt_1ABC',
		amount: 1200,
		currency: 'usd',
		product: 'Kody Standard',
		customerName: 'Ada',
		customerEmail: 'ada@example.com',
		livemode: true,
	})
}
```

Rules that keep this safe:

- Fetch-back verify. Do not trust the webhook JSON beyond the event id.
- Draft. Do not send. If the Google token can send, lock the published package
  and the integration so execute cannot widen it. See
  [Gmail drafts without send](./locked-gmail-drafts.md).
- Money alerts stay out of this package. Kent keeps those in
  [`@kentcdodds/stripe-alerts`](https://kody.codes/@kentcdodds/stripe-alerts).
- Never log customer email, checkout session ids, or receipt URLs in public
  channels.
- After publish, smoke-test the webhook export with a dry-run payload, or replay
  `thankPurchase` on facts you already verified. For the owned-topic shape, use
  `packageSubscriptionDispatch`.

## Example prompts

**Build the event shape**

> Search Kody for purchase thanks and package-emitted events. I want
> `@me/purchase.completed` emitted after a verified paid checkout, and a second
> package that drafts a thank-you (never send) when that event lands. Show me
> the `kody.emits` and `kody.subscriptions` snippets, then persist both
> packages. Smoke-test the subscriber with packageSubscriptionDispatch.

**Fork the public one**

> Open https://kody.codes/@kentcdodds/stripe-purchase-thanks, fork it, and point
> the Stripe webhook at my checkout. Keep drafts-only. Do not send. Do not
> disable Kent's live `stripe` webhook.

**Replay one purchase**

> Import `thankPurchase` from my fork and replay event `evt_…` that I already
> verified. Show me which Gmail thread it picked and the draft id. Do not send
> the draft.

## What you see

| Surface                     | What it is for                                                      |
| --------------------------- | ------------------------------------------------------------------- |
| Stripe dashboard → webhooks | The minted Kody URL (copied from package settings, never from chat) |
| Package settings → Webhooks | Mint / reveal / rotate for the `stripe` door                        |
| Gmail Drafts                | The thank-you, To = buyer, waiting on a human to send               |
| Discord (Kent's copy)       | One-liner that the draft is ready                                   |
| `/@<slug>/-/activity`       | Webhook deliveries and subscription runs                            |
| Chat (`execute`)            | Replay `thankPurchase` or dry-run the webhook handler               |

The homepage card is a tile with the kicker **Event** and the title **Purchase
thanks**. It links here.

## Where to go next

- [Subscriptions and events](./package-subscriptions.md) — `kody.emits`,
  `events.dispatch`, filters, synthetic dispatch.
- [Inbound webhooks](../use/webhooks.md) — Stripe signature windows and mint /
  rotate.
- [Gmail drafts without send](./locked-gmail-drafts.md) — lock the package so a
  later agent cannot send.
- [Flake Hunter](./flake-hunter.md) — the cron sibling on the same homepage row.
