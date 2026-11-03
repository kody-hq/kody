/**
 * Automatic outbound-email abuse pause.
 *
 * All user mail sends from one shared platform domain through one
 * Cloudflare Email Sending account, so a single account generating spam
 * complaints or sustained bounces burns sender reputation for every user.
 * This monitor reacts to provider delivery events: any spam complaint, or
 * repeated hard bounces within a UTC day, sets
 * `orgs.email_outbound_paused_at`, which blocks further outbound sends
 * (see `sendOutboundEmail`) until an admin reviews and clears it from the
 * admin users page.
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { dispatchUserEmailOutboundPausedSubscriptionEvent } from './outbound-paused-package-subscriptions.ts'
import {
	buildUserEmailOutboundPausedEvent,
	isUserEmailOutboundPausedReason,
} from './outbound-paused-subscription-event.ts'
import type { EmailDeliveryStatus } from './types.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Bounced sends tolerated per user per UTC day before outbound email is
 * paused. Complaints pause immediately: one recipient marking mail as spam
 * is already a reputation signal the shared domain cannot absorb quietly.
 */
export const outboundEmailBouncePauseThresholdPerDay = 5

export const emailOutboundPausedMessage =
	'Outbound email is paused for this account after spam complaints or repeated bounces. Email support@kody.codes to have it reviewed and re-enabled.'

type OutboundAbuseEnv = Pick<
	Env,
	'APP_DB' | 'APP_BASE_URL' | 'BUNDLE_ARTIFACTS_KV' | 'MAILBOX'
>

/**
 * Evaluate one provider delivery event against the abuse thresholds and
 * pause the sending account when they are exceeded. Idempotent: the pause
 * write only transitions a NULL `email_outbound_paused_at`, so replayed
 * queue messages and duplicate provider events can never re-pause or
 * re-notify. Returns whether this call performed the pause transition.
 */
export async function applyOutboundEmailAbusePause(input: {
	env: OutboundAbuseEnv
	/** Stable MCP userId of the account that sent the message. */
	userId: OwnerId
	deliveryStatus: EmailDeliveryStatus
	/**
	 * Whether this delivery event was persisted by the current processing
	 * run (queue outcome `recorded`). Replayed and conflicting-duplicate
	 * signals are deduped by provider_event_id at insert time, so the same
	 * provider event can only ever count once: non-recorded signals only
	 * pause when a matching persisted event backs them.
	 */
	eventRecorded: boolean
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{ paused: boolean }> {
	const now = input.now ?? new Date()
	switch (input.deliveryStatus) {
		case 'complained': {
			// A freshly recorded complaint always pauses. A replayed or
			// conflicting-duplicate complaint signal only pauses when a
			// real persisted complaint event backs it (crash recovery
			// between recording and pausing), never on its own.
			if (!input.eventRecorded) {
				const complaintsToday = await countProviderDeliveryEventsToday({
					env: input.env,
					userId: input.userId,
					eventType: 'complained',
					now,
				})
				if (complaintsToday < 1) return { paused: false }
			}
			break
		}
		case 'bounced': {
			const bouncesToday = await countProviderDeliveryEventsToday({
				env: input.env,
				userId: input.userId,
				eventType: 'bounced',
				now,
			})
			if (bouncesToday < outboundEmailBouncePauseThresholdPerDay) {
				return { paused: false }
			}
			break
		}
		case 'delivered':
		case 'deferred':
		case 'failed':
		case 'rejected':
			return { paused: false }
		default: {
			const exhaustive: never = input.deliveryStatus
			throw new Error(`Unsupported delivery status: ${String(exhaustive)}`)
		}
	}

	const result = await input.env.APP_DB.prepare(
		`UPDATE orgs
		 SET email_outbound_paused_at = ?, updated_at = ?
		 WHERE id = ? AND email_outbound_paused_at IS NULL${andLiveDeletedAtSql()}`,
	)
		.bind(now.toISOString(), now.toISOString(), input.userId)
		.run()
	const paused = Number(result.meta.changes ?? 0) > 0
	if (paused) {
		console.warn('email-outbound-paused', {
			deliveryStatus: input.deliveryStatus,
		})
		await notifyAdminsOfOutboundEmailPause({
			env: input.env,
			userId: input.userId,
			deliveryStatus: input.deliveryStatus,
			waitUntil: input.waitUntil,
		})
	}
	return { paused }
}

async function countProviderDeliveryEventsToday(input: {
	env: OutboundAbuseEnv
	userId: OwnerId
	eventType: EmailDeliveryStatus
	now: Date
}) {
	const dayStart = `${utcDayKey(input.now)}T00:00:00.000Z`
	const result = await mailboxRpc({
		env: input.env,
		userId: input.userId,
	}).countDeliveryEvents({
		ownerId: input.userId,
		eventType: input.eventType,
		provider: 'cloudflare-email',
		createdAtGte: dayStart,
	})
	return result.count
}

/**
 * Best-effort operator notification: fans `user.email_outbound.paused` to
 * admin-owned packages. A dispatch failure must never fail delivery-event
 * processing — the pause itself is already committed and the admin users
 * page shows the paused state.
 */
async function notifyAdminsOfOutboundEmailPause(input: {
	env: OutboundAbuseEnv
	userId: OwnerId
	deliveryStatus: EmailDeliveryStatus
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	try {
		if (!isUserEmailOutboundPausedReason(input.deliveryStatus)) return
		const pausedUser = await input.env.APP_DB.prepare(
			`SELECT username, email FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(input.userId)
			.first<{ username: string; email: string }>()
		const dispatchPromise = dispatchUserEmailOutboundPausedSubscriptionEvent({
			env: input.env,
			event: buildUserEmailOutboundPausedEvent({
				user: {
					id: input.userId,
					username: pausedUser?.username ?? 'unknown',
					email: pausedUser?.email ?? '',
				},
				reason: input.deliveryStatus,
				bounceThreshold: outboundEmailBouncePauseThresholdPerDay,
				adminUserUrl: joinAppUrl({
					env: input.env,
					path: pausedUser ? `/admin/users/${input.userId}` : '/admin/users',
				}),
				occurredAt: new Date().toISOString(),
			}),
			waitUntil: input.waitUntil,
		}).catch((error) => {
			console.warn('email-outbound-paused-subscription-dispatch-failed', error)
		})
		// Do not await fan-out on the queue path: a hung invoke can time out
		// the consumer after the pause is already committed, and retries skip
		// this notify because the pause write is a no-op.
		if (input.waitUntil) {
			input.waitUntil(dispatchPromise)
			return
		}
		await dispatchPromise
	} catch (error) {
		console.warn('email-outbound-pause-notification-failed', error)
	}
}
