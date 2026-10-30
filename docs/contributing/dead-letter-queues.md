# Dead-letter queues

Every production Cloudflare Queue consumer has a dead-letter queue (DLQ). A
message lands there after its source consumer exhausts `max_retries`. The origin
worker consumes every production DLQ, parks each message in APP_DB
(`dead_letter_messages`), and acks it. Admins inspect and resolve parked
messages with the admin capabilities below.

| DLQ                                             | Source queue                                | Replay                                       |
| ----------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `kody-email-delivery-dlq`                       | `kody-email-delivery`                       | Unsupported (no producer binding); ack       |
| `kody-artifacts-repo-events-dlq`                | `kody-artifacts-repo-events`                | Unsupported (no producer binding); ack       |
| `kody-platform-feedback-dispatch-dlq`           | `kody-platform-feedback-dispatch`           | `PLATFORM_FEEDBACK_DISPATCH_QUEUE`           |
| `kody-community-activity-dispatch-dlq`          | `kody-community-activity-dispatch`          | `COMMUNITY_ACTIVITY_DISPATCH_QUEUE`          |
| `kody-community-listing-published-dispatch-dlq` | `kody-community-listing-published-dispatch` | `COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE` |
| `kody-package-events-dispatch-dlq`              | `kody-package-events-dispatch`              | `PACKAGE_EVENTS_DISPATCH_QUEUE`              |
| `kody-webhook-dispatch-dlq`                     | `kody-webhook-dispatch`                     | `WEBHOOK_DISPATCH_QUEUE`                     |
| `kody-scheduled-dispatch-dlq`                   | `kody-scheduled-dispatch`                   | Jobs worker `replayScheduledDispatchMessage` |

The registry lives in `packages/worker/src/dead-letter/queues.ts`.
`tools/ci/production-queue-resources.ts` fails CI when a production DLQ has no
parking consumer in `packages/worker/wrangler.jsonc`.

## Why park instead of the Queues HTTP API

Cloudflare's pull/ack/purge HTTP endpoints need a pull consumer (a queue has one
consumer, so the DLQ could not also be pushed to a worker) and an API token with
Queues write scope. The worker's existing `CLOUDFLARE_API_TOKEN` is only relied
on for queue metrics reads. Parking needs no new token, binding, queue, or
permission: it uses the existing APP_DB binding and the existing producer
bindings for replay. Ack, replay, and purge also write Kody's own audit log.
Audit rows live in a separate database (AUDIT_DB), so they are best-effort, not
transactional with the APP_DB delete.

## Capabilities

All are in the `admin` domain (`requiredRole: 'admin'`, `contextRuns: 'deny'`).
Call them through `execute` like any other admin capability.

- `adminDeadLetterQueueList`: depth and oldest-message age for every DLQ.
  `depth` is parked messages plus any Cloudflare backlog not yet parked
  (Cloudflare metrics are read only in production).
- `adminDeadLetterQueuePeek`: redacted metadata for parked messages, oldest
  first (`queue`, optional `message_id`, `limit`, `cursor`).
- `adminDeadLetterQueueReplay`: resend one parked message to its source queue,
  then remove it (`queue`, `message_id`).
- `adminDeadLetterQueueAck`: delete one parked message without replaying
  (`queue`, `message_id`).
- `adminDeadLetterQueuePurge`: delete parked messages in one DLQ, oldest first,
  up to 200 per call. `confirm` must equal the queue name exactly. Repeat while
  `remaining_count > 0`.

```ts
// execute module
import { kody } from 'kody:runtime'

export default async function main() {
	const { queues } = await kody.adminDeadLetterQueueList({})
	const peek = await kody.adminDeadLetterQueuePeek({
		queue: 'kody-platform-feedback-dispatch-dlq',
	})
	// After triage, ack the one message (or replay it instead):
	// await kody.adminDeadLetterQueueAck({
	// 	queue: 'kody-platform-feedback-dispatch-dlq',
	// 	message_id: peek.messages[0].message_id,
	// })
	return { queues, peek }
}
```

## Safety rules

- Peek never returns message bodies. It returns ids, attempts, timestamps,
  source queue, payload type and size, identifier-shaped top-level key names, a
  `kind`/`type`/`lane` value when it looks like an identifier, and id-shaped
  fields (`feedbackId`, `deliveryId`, ...) whose values look like ids. Keys that
  look sensitive (`token`, `secret`, `session`, `email`, ...) never yield
  values. The stored body exists only so replay can resend it.
- Replay, ack, and purge are audit-logged (`category: admin`) with the acting
  admin, queue, message id(s), and outcome; purge writes one row per message
  plus a summary row. Failures are audited too.
- Replay claims the row first, so two concurrent replays cannot both send. A
  failed send releases the claim and reports to Sentry. If the send succeeds but
  the row cannot be removed, the error says so: ack the message so it is not
  replayed twice.
- Parking failures report to Sentry (`dead_letter.stage: park`, queue, message
  id, attempts) and retry with exponential backoff (60 seconds doubling to a
  45-minute cap) for up to 100 attempts, about 71 hours of APP_DB outage. That
  stays inside the DLQs' default 4-day Cloudflare message retention, so the
  final attempt runs (and reports) before the queue could expire the message.
  The DLQ consumers have no further DLQ, so a message that exhausts them is
  deleted; the last attempt reports at `fatal` level.
- Alerting is unchanged in spirit: the DLQ depth alert counts parked rows, so a
  DLQ keeps paging (`dlq-depth` fingerprint) until an admin replays, acks, or
  purges its messages.
- Production mutation is operator-controlled. Agents must not replay, ack, or
  purge production messages unless the operator asks for that exact action.
