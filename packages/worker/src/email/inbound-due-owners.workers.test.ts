import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	hintInboundDueOwner,
	listDueInboundOwners,
	replaceInboundDueOwnerHint,
} from './inbound-due-owners.ts'
import type { Mailbox } from './mailbox-do.ts'
import {
	baseMessage,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'
import { sweepStaleInboundDeliveries } from './reconcile-inbound-deliveries.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const now = new Date('2026-08-03T12:00:00.000Z')
const sweepEnv = { ...env, APP_BASE_URL: 'https://kody.example.com' }

async function seedUsers(labels: Array<string>) {
	const userIds: Array<string> = []
	for (const label of labels) {
		const email = `${label}-${crypto.randomUUID()}@example.test`
		const userId = testStableUserIdFromEmail(email)
		await env.APP_DB.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (?, ?, 'hash', ?)`,
		)
			.bind(`${label}-${crypto.randomUUID()}`, email, userId)
			.run()
		userIds.push(userId)
	}
	return userIds
}

function hint(userId: string, dueAt: string, reason: string) {
	return replaceInboundDueOwnerHint({
		db: env.APP_DB,
		userId,
		dueAt,
		reason,
		now,
	})
}

async function readDueOwners(userIds: Array<string>) {
	const rows = await env.APP_DB.prepare(
		`SELECT user_id, due_at, reason
		FROM email_inbound_due_owners
		WHERE user_id IN (${userIds.map(() => '?').join(', ')})
		ORDER BY user_id`,
	)
		.bind(...userIds)
		.all<{ user_id: string; due_at: string; reason: string }>()
	return rows.results
}

test('Mailbox alarm repairs a missed due-owner transition hint', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = uniqueUserId('due-hint-repair')
	const at = '2026-08-03T00:00:00.000Z'
	await rpcFor(userId).upsertMessageGraph({
		ownerId: userId,
		message: baseMessage(userId, {
			direction: 'outbound',
			inboxId: null,
			createdAt: at,
		}),
	})
	await runInDurableObject(
		stubFor(userId),
		async (instance: Mailbox, state) => {
			state.storage.sql.exec(
				`INSERT INTO email_delivery_events (
				id, event_type, provider, needs_effect_reconcile, state,
				created_at, updated_at
			) VALUES (?, 'received', 'cloudflare-email-routing', 1, 'received', ?, ?)`,
				'due-hint-event',
				at,
				at,
			)
			await instance.alarm()
		},
	)
	expect(await readDueOwners([userId])).toMatchObject([
		{ user_id: userId, reason: 'mailbox-due-work' },
	])
})

test('due-owner discovery is bounded and ordered without a users scan', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	for (const [index, dueAt] of [
		'2026-08-03T11:03:00.000Z',
		'2026-08-03T11:01:00.000Z',
		'2026-08-03T11:02:00.000Z',
		'2026-08-03T11:00:00.000Z',
	].entries()) {
		await hint(`due-owner-${index}`, dueAt, 'test')
	}
	const due = await listDueInboundOwners({ db: env.APP_DB, now, limit: 3 })
	expect(due.map((owner) => owner.dueAt)).toEqual([
		'2026-08-03T11:00:00.000Z',
		'2026-08-03T11:01:00.000Z',
		'2026-08-03T11:02:00.000Z',
	])
})

test('due-owner drain is bounded and ordered by due time', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const latestUserId = `latest-${crypto.randomUUID()}`
	const insertDueOwner = (userId: string, dueAt: string, reason: string) =>
		env.APP_DB.prepare(
			`INSERT INTO email_inbound_due_owners (
				user_id, due_at, reason, attempt_count, last_error, updated_at
			) VALUES (?, ?, ?, 0, NULL, ?)`,
		).bind(userId, dueAt, reason, now.toISOString())
	await env.APP_DB.batch([
		...Array.from({ length: 100 }, (_, index) =>
			insertDueOwner(
				`backlog-${String(index).padStart(3, '0')}-${crypto.randomUUID()}`,
				'2026-08-03T11:00:00.000Z',
				'scheduled-refresh',
			),
		),
		insertDueOwner(
			latestUserId,
			'2026-08-03T11:59:00.000Z',
			'mailbox-due-work',
		),
	])

	const batchSizes: Array<number> = []
	const drainedUserIds: Array<string> = []
	for (;;) {
		const due = await listDueInboundOwners({ db: env.APP_DB, now })
		if (due.length === 0) break
		batchSizes.push(due.length)
		drainedUserIds.push(...due.map((owner) => owner.userId))
		await env.APP_DB.batch(
			due.map((owner) =>
				env.APP_DB.prepare(
					`DELETE FROM email_inbound_due_owners WHERE user_id = ?`,
				).bind(owner.userId),
			),
		)
	}

	expect(drainedUserIds.at(-1)).toBe(latestUserId)
	expect(batchSizes).toEqual([25, 25, 25, 25, 1])
	expect(drainedUserIds).toHaveLength(101)
})

test('hint upsert keeps the earliest due time and its reason', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `hint-merge-${crypto.randomUUID()}`
	// [dueAt, reason, stored due_at, stored reason]: a later hint never moves
	// the due time forward or replaces the reason; an earlier hint wins both.
	const hints = [
		['11:30', 'mailbox-due-work', '11:30', 'mailbox-due-work'],
		['11:45', 'scheduled-refresh', '11:30', 'mailbox-due-work'],
		['11:15', 'scheduled-refresh', '11:15', 'scheduled-refresh'],
	] as const
	const at = (time: string) => `2026-08-03T${time}:00.000Z`
	const stored: Array<unknown> = []
	for (const [dueAt, reason] of hints) {
		await hintInboundDueOwner({
			db: env.APP_DB,
			userId,
			dueAt: at(dueAt),
			reason,
			now,
		})
		stored.push((await readDueOwners([userId]))[0])
	}
	expect(stored).toMatchObject(
		hints.map(([, , dueAt, reason]) => ({ due_at: at(dueAt), reason })),
	)
})

test('sweep time budget defers later owners to the next pass', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const [earlierUserId, laterUserId] = (await seedUsers([
		'budget-earlier',
		'budget-later',
	])) as [string, string]
	await hint(earlierUserId, '2026-08-03T10:00:00.000Z', 'scheduled-refresh')
	await hint(laterUserId, '2026-08-03T11:00:00.000Z', 'mailbox-due-work')
	await Promise.all([
		rpcFor(ownerIdFromStored(earlierUserId)).getInboundDueWorkHint({
			ownerId: ownerIdFromStored(earlierUserId),
		}),
		rpcFor(ownerIdFromStored(laterUserId)).getInboundDueWorkHint({
			ownerId: ownerIdFromStored(laterUserId),
		}),
	])
	const clockValues = [0, 0, 10_001, 10_001]

	await expect(
		sweepStaleInboundDeliveries({
			env: sweepEnv,
			now,
			clock: () => clockValues.shift() ?? 10_001,
		}),
	).resolves.toMatchObject({
		usersProcessed: 1,
		errors: 0,
		budgetExhausted: true,
	})
	expect(await readDueOwners([earlierUserId, laterUserId])).toMatchObject([
		{ user_id: laterUserId, reason: 'mailbox-due-work' },
	])
})

test('sweep clears a healthy Mailbox hint and retains pending due work', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const dueAt = now.toISOString()
	const [healthyUserId, pendingUserId] = (await seedUsers([
		'healthy',
		'pending',
	])) as [string, string]
	for (const userId of [healthyUserId, pendingUserId]) {
		await hint(userId, dueAt, 'scheduled-refresh')
		await rpcFor(ownerIdFromStored(userId)).getInboundDueWorkHint({
			ownerId: ownerIdFromStored(userId),
		})
	}

	await runInDurableObject(
		stubFor(ownerIdFromStored(pendingUserId)),
		async (instance: Mailbox, state) => {
			await instance.getInboundDueWorkHint({
				ownerId: ownerIdFromStored(pendingUserId),
			})
			state.storage.sql.exec(
				`INSERT INTO email_delivery_events (
					id, event_type, provider, needs_effect_reconcile, state,
					created_at, updated_at
				) VALUES (?, 'receive_started', 'cloudflare-email-routing', 0,
					'pending', ?, ?)`,
				`pending-${crypto.randomUUID()}`,
				dueAt,
				dueAt,
			)
		},
	)

	await expect(
		sweepStaleInboundDeliveries({ env: sweepEnv, now }),
	).resolves.toMatchObject({ usersProcessed: 2, errors: 0 })
	expect(await readDueOwners([healthyUserId, pendingUserId])).toEqual([
		{
			user_id: pendingUserId,
			due_at: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
			reason: 'scheduled-refresh',
		},
	])
})
