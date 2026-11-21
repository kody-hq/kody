import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { replaceInboundDueOwnerHint } from './inbound-due-owners.ts'
import { rpcFor } from './mailbox-test-helpers.ts'
import {
	sweepStaleInboundDeliveries as sweepPromise,
	sweepStaleInboundDeliveriesViaEffect,
} from './reconcile-inbound-deliveries.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const appBaseUrl = 'https://kody.example.com'
const sweepNow = new Date('2026-08-03T00:00:00.000Z')

async function seedStaleUserDelivery(label: string, createdAt: string) {
	const email = `${label}-${crypto.randomUUID()}@example.test`
	const userId = testStableUserIdFromEmail(email)
	const inboxId = `${label}-inbox-${crypto.randomUUID()}`
	const deliveryId = `${label}-delivery-${crypto.randomUUID()}`
	const messageId = `${label}-message-${crypto.randomUUID()}`
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, deleting_at
			) VALUES (?, ?, 'hash', ?, NULL)`,
		).bind(`${label}-${crypto.randomUUID()}`, email, userId),
		env.APP_DB.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, name, description, enabled, created_at, updated_at
			) VALUES (?, ?, 'Reconcile fixture', '', 1, ?, ?)`,
		).bind(inboxId, userId, createdAt, createdAt),
	])
	await rpcFor(ownerIdFromStored(userId)).insertChargedPendingInboundDelivery({
		ownerId: ownerIdFromStored(userId),
		delivery: {
			fingerprint: `${label}-fingerprint-${crypto.randomUUID()}`,
			deliveryId,
			messageId,
			threadId: `${label}-thread-${crypto.randomUUID()}`,
			rawMimeKey: emailRawMimeKey(ownerIdFromStored(userId), messageId),
			inboxId,
			recipient: email,
			envelopeFrom: 'sender@example.test',
			provider: 'cloudflare-email-routing',
			quotaDay: createdAt.slice(0, 10),
			dedupeExpiresAt: '2026-08-04T00:00:00.000Z',
		},
		now: createdAt,
	})
	await replaceInboundDueOwnerHint({
		db: env.APP_DB,
		userId,
		dueAt: createdAt,
		reason: 'test-stale-delivery',
		now: sweepNow,
	})
	const authorityEnv = { ...env, APP_BASE_URL: appBaseUrl }
	const authority = createUserInboundDeliveryAuthority({
		env: authorityEnv,
		userId: ownerIdFromStored(userId),
	})
	expect(await authority.get(deliveryId)).toMatchObject({
		deliveryId,
		state: 'pending',
	})
	return { userId, deliveryId }
}

async function restoreSystemMarker() {
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO system_email_graph_authority (
			singleton, authority, cutover_at, graph_mismatch_count,
			provider_link_count
		) VALUES (1, 'dedicated', CURRENT_TIMESTAMP, 0, 0)`,
	).run()
}

// Runs two full sweep passes over real mailbox DOs; needs headroom beyond the
// 5s local default when the whole suite runs in parallel.
describe.each([
	{ path: 'promise', sweepStaleInboundDeliveries: sweepPromise },
	{
		path: 'effect',
		sweepStaleInboundDeliveries: sweepStaleInboundDeliveriesViaEffect,
	},
])('$path path', ({ sweepStaleInboundDeliveries }) => {
	test(
		'inbound reconciliation keeps user work moving when system authority is unavailable',
		{ timeout: 30_000 },
		async () => {
			consoleWarn.mockImplementation(() => {})
			await ensureEmailTestSchema(env.APP_DB)

			const userOnly = await seedStaleUserDelivery(
				'user-only',
				'2026-07-31T00:00:00.000Z',
			)
			await env.APP_DB.prepare(
				`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
			).run()

			try {
				const userOnlyResult = await sweepStaleInboundDeliveries({
					env: { ...env, APP_BASE_URL: appBaseUrl },
					now: sweepNow,
				})
				expect(userOnlyResult).toMatchObject({
					usersProcessed: 1,
					recovered: 0,
					cleaned: 1,
					pointersPruned: 0,
					effectsProcessed: 0,
					errors: 0,
				})
				expect(consoleWarn).not.toHaveBeenCalled()
				expect(
					await rpcFor(ownerIdFromStored(userOnly.userId)).getInboundDelivery({
						ownerId: ownerIdFromStored(userOnly.userId),
						deliveryId: userOnly.deliveryId,
					}),
				).toMatchObject({ state: 'orphan-cleaned' })
			} finally {
				await restoreSystemMarker()
			}

			consoleWarn.mockClear()
			const userAfterSystem = await seedStaleUserDelivery(
				'user-after-system',
				'2026-07-31T00:00:00.000Z',
			)
			const systemDeliveryId = `system-due-${crypto.randomUUID()}`
			await env.APP_DB.prepare(
				`INSERT INTO system_email_delivery_events (
				id, event_type, provider, detail_json, needs_effect_reconcile,
				state, fingerprint, created_at, updated_at
			) VALUES (
				?, 'receive_started', 'cloudflare-email-routing', '{}', 0,
				'pending', ?, '2026-07-30T00:00:00.000Z',
				'2026-07-30T00:00:00.000Z'
			)`,
			)
				.bind(systemDeliveryId, `system-fingerprint-${crypto.randomUUID()}`)
				.run()
			await env.APP_DB.prepare(
				`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
			).run()

			try {
				const isolatedResult = await sweepStaleInboundDeliveries({
					env: { ...env, APP_BASE_URL: appBaseUrl },
					now: sweepNow,
				})
				expect(isolatedResult).toMatchObject({
					recovered: 0,
					cleaned: 1,
					pointersPruned: 0,
					effectsProcessed: 0,
					errors: 1,
				})
				expect(isolatedResult.usersProcessed).toBeGreaterThanOrEqual(2)
				expect(consoleWarn).toHaveBeenCalledTimes(1)
				expect(consoleWarn).toHaveBeenCalledWith(
					'inbound-email-user-reconciliation-failed',
					systemEmailOwnerId,
					expect.objectContaining({
						message: expect.stringContaining(
							'authority marker is missing or invalid',
						),
					}),
				)
				expect(
					await rpcFor(
						ownerIdFromStored(userAfterSystem.userId),
					).getInboundDelivery({
						ownerId: ownerIdFromStored(userAfterSystem.userId),
						deliveryId: userAfterSystem.deliveryId,
					}),
				).toMatchObject({ state: 'orphan-cleaned' })
				expect(
					await env.APP_DB.prepare(
						`SELECT state FROM system_email_delivery_events WHERE id = ?`,
					)
						.bind(systemDeliveryId)
						.first(),
				).toEqual({ state: 'pending' })
			} finally {
				await restoreSystemMarker()
			}
		},
	)
})
