import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { mcpEventSecretRotationGraceMs } from './constants.ts'
import {
	buildMcpEventSubscriptionId,
	countLiveMcpEventSubscriptionsForPrincipal,
	deleteExpiredMcpEventSubscriptions,
	deleteMcpEventSubscription,
	deleteMcpEventSubscriptionsForOauthClient,
	deleteMcpEventSubscriptionsForUser,
	findRecentMcpEventCallbackVerification,
	getMcpEventSubscription,
	listDeliverableMcpEventSubscriptions,
	readMcpEventSubscriptionSigningSecrets,
	recordMcpEventDeliveryOutcome,
	upsertMcpEventSubscription,
	type McpEventSubscriptionKey,
} from './subscriptions-repo.ts'

const env = { SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum' }
const secretA = `whsec_${Buffer.alloc(32, 1).toString('base64')}`
const secretB = `whsec_${Buffer.alloc(32, 2).toString('base64')}`
const now = new Date('2026-10-07T12:00:00.000Z')
const hourMs = 60 * 60 * 1000

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function key(
	overrides: Partial<McpEventSubscriptionKey> = {},
): McpEventSubscriptionKey {
	return {
		userId: ownerIdFromStored('user-1'),
		oauthClientId: 'client-a',
		eventName: '@kentcdodds/discord.message.created',
		arguments: {},
		callbackUrl: 'https://hooks.example.com/kody',
		...overrides,
	}
}

async function save(
	db: D1Database,
	subscriptionKey: McpEventSubscriptionKey,
	options: {
		secret?: string
		refreshBefore?: Date
		verifiedAt?: string
		at?: Date
	} = {},
) {
	const id = await buildMcpEventSubscriptionId(subscriptionKey)
	const at = options.at ?? now
	return await upsertMcpEventSubscription({
		db,
		env,
		id,
		key: subscriptionKey,
		secret: options.secret ?? secretA,
		refreshBefore: options.refreshBefore ?? new Date(at.getTime() + hourMs),
		verifiedAt: options.verifiedAt ?? at.toISOString(),
		now: at,
	})
}

test('subscription ids are deterministic over the full key and argument order', async () => {
	const base = await buildMcpEventSubscriptionId(key())
	expect(base).toMatch(/^sub_[0-9a-f]{32}$/)
	expect(await buildMcpEventSubscriptionId(key())).toBe(base)
	expect(
		await buildMcpEventSubscriptionId(key({ arguments: { a: 1, b: 2 } })),
	).toBe(await buildMcpEventSubscriptionId(key({ arguments: { b: 2, a: 1 } })))
	const variants = await Promise.all(
		[
			key({ userId: ownerIdFromStored('user-2') }),
			key({ oauthClientId: 'client-b' }),
			key({ eventName: 'other.topic' }),
			key({ arguments: { a: 1 } }),
			key({ callbackUrl: 'https://hooks.example.com/other' }),
		].map(buildMcpEventSubscriptionId),
	)
	expect(new Set([base, ...variants]).size).toBe(6)
})

test('upsert stores an encrypted secret and refreshes in place', async () => {
	const { sqlite, db } = createDb()
	const created = await save(db, key())
	expect(created).toMatchObject({
		userId: ownerIdFromStored('user-1'),
		oauthClientId: 'client-a',
		eventName: '@kentcdodds/discord.message.created',
		argumentsJson: '{}',
		callbackUrl: 'https://hooks.example.com/kody',
		refreshBefore: new Date(now.getTime() + hourMs).toISOString(),
		verifiedAt: now.toISOString(),
		active: true,
		lastDeliveryAt: null,
		lastError: null,
	})
	const stored = sqlite
		.prepare(`SELECT secret_encrypted FROM mcp_event_subscriptions`)
		.get() as { secret_encrypted: string }
	expect(stored.secret_encrypted).not.toContain(secretA.slice(6))

	const later = new Date(now.getTime() + 10 * 60 * 1000)
	const refreshed = await save(db, key(), {
		at: later,
		refreshBefore: new Date(later.getTime() + 2 * hourMs),
	})
	expect(refreshed.id).toBe(created.id)
	expect(refreshed.refreshBefore).toBe(
		new Date(later.getTime() + 2 * hourMs).toISOString(),
	)
	await expect(
		readMcpEventSubscriptionSigningSecrets({
			db,
			env,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
			now: later,
		}),
	).resolves.toEqual([secretA])
})

test('secret rotation co-signs with the previous secret only during the grace window', async () => {
	const { db } = createDb()
	const created = await save(db, key(), { secret: secretA })
	const rotatedAt = new Date(now.getTime() + 60_000)
	await save(db, key(), { secret: secretB, at: rotatedAt })
	const read = (at: Date) =>
		readMcpEventSubscriptionSigningSecrets({
			db,
			env,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
			now: at,
		})
	await expect(read(rotatedAt)).resolves.toEqual([secretB, secretA])
	await expect(
		read(new Date(rotatedAt.getTime() + mcpEventSecretRotationGraceMs + 1)),
	).resolves.toEqual([secretB])
	// Refreshing with the same secret keeps the existing rotation window.
	await save(db, key(), { secret: secretB, at: rotatedAt })
	await expect(read(rotatedAt)).resolves.toEqual([secretB, secretA])
	await expect(
		readMcpEventSubscriptionSigningSecrets({
			db,
			env,
			userId: ownerIdFromStored('user-2'),
			id: created.id,
			now,
		}),
	).rejects.toThrow(/not found/)
})

test('deliverable listing excludes expired, unverified, inactive, and other-topic rows', async () => {
	const { sqlite, db } = createDb()
	const live = await save(db, key())
	await save(db, key({ callbackUrl: 'https://hooks.example.com/expired' }), {
		refreshBefore: new Date(now.getTime() - 1),
	})
	const unverified = await save(
		db,
		key({ callbackUrl: 'https://hooks.example.com/unverified' }),
	)
	sqlite
		.prepare(
			`UPDATE mcp_event_subscriptions SET verified_at = NULL WHERE id = ?`,
		)
		.run(unverified.id)
	const inactive = await save(
		db,
		key({ callbackUrl: 'https://hooks.example.com/inactive' }),
	)
	sqlite
		.prepare(`UPDATE mcp_event_subscriptions SET active = 0 WHERE id = ?`)
		.run(inactive.id)
	await save(db, key({ eventName: 'other.topic' }))
	await save(db, key({ userId: ownerIdFromStored('user-2') }))

	const deliverable = await listDeliverableMcpEventSubscriptions({
		db,
		userId: ownerIdFromStored('user-1'),
		eventName: '@kentcdodds/discord.message.created',
		now,
	})
	expect(deliverable.map((row) => row.id)).toEqual([live.id])

	expect(
		await countLiveMcpEventSubscriptionsForPrincipal({
			db,
			userId: ownerIdFromStored('user-1'),
			oauthClientId: 'client-a',
			now,
		}),
	).toBe(4)
	await deleteExpiredMcpEventSubscriptions({
		db,
		userId: ownerIdFromStored('user-1'),
		now,
	})
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM mcp_event_subscriptions WHERE user_id = 'user-1'`,
			)
			.get(),
	).toEqual({ count: 4 })
})

test('callback verification is cached per principal, url, and secret', async () => {
	const { db } = createDb()
	const verifiedAt = new Date(now.getTime() - hourMs).toISOString()
	await save(db, key(), { verifiedAt })
	const lookup = (
		overrides: Partial<McpEventSubscriptionKey> & { secret?: string },
		since: Date,
	) =>
		findRecentMcpEventCallbackVerification({
			db,
			env,
			userId: overrides.userId ?? ownerIdFromStored('user-1'),
			oauthClientId: overrides.oauthClientId ?? 'client-a',
			callbackUrl: overrides.callbackUrl ?? 'https://hooks.example.com/kody',
			secret: overrides.secret ?? secretA,
			verifiedSince: since,
		})
	const dayAgo = new Date(now.getTime() - 24 * hourMs)
	await expect(lookup({}, dayAgo)).resolves.toBe(verifiedAt)
	await expect(lookup({ secret: secretB }, dayAgo)).resolves.toBeNull()
	await expect(lookup({}, now)).resolves.toBeNull()
	await expect(
		lookup({ oauthClientId: 'client-b' }, dayAgo),
	).resolves.toBeNull()
	await expect(
		lookup({ userId: ownerIdFromStored('user-2') }, dayAgo),
	).resolves.toBeNull()
	await expect(
		lookup({ callbackUrl: 'https://hooks.example.com/other' }, dayAgo),
	).resolves.toBeNull()
})

test('delivery outcomes record last delivery and last error', async () => {
	const { db } = createDb()
	const created = await save(db, key())
	const deliveredAt = new Date(now.getTime() + 1000)
	await recordMcpEventDeliveryOutcome({
		db,
		userId: ownerIdFromStored('user-1'),
		id: created.id,
		now: deliveredAt,
		outcome: { ok: true },
	})
	await expect(
		getMcpEventSubscription({
			db,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
		}),
	).resolves.toMatchObject({
		lastDeliveryAt: deliveredAt.toISOString(),
		lastError: null,
	})
	await recordMcpEventDeliveryOutcome({
		db,
		userId: ownerIdFromStored('user-1'),
		id: created.id,
		now: new Date(now.getTime() + 2000),
		outcome: { ok: false, error: 'http_5xx' },
	})
	await expect(
		getMcpEventSubscription({
			db,
			userId: ownerIdFromStored('user-1'),
			id: created.id,
		}),
	).resolves.toMatchObject({
		lastDeliveryAt: deliveredAt.toISOString(),
		lastError: 'http_5xx',
	})
})

test('revoke cleanup deletes by client (optionally per user) and by user', async () => {
	const { db } = createDb()
	const userOneClientA = await save(db, key())
	const userTwoClientA = await save(
		db,
		key({ userId: ownerIdFromStored('user-2') }),
	)
	const userOneClientB = await save(db, key({ oauthClientId: 'client-b' }))
	const userTwoClientB = await save(
		db,
		key({ userId: ownerIdFromStored('user-2'), oauthClientId: 'client-b' }),
	)
	const remaining = async () =>
		(
			await Promise.all(
				[userOneClientA, userTwoClientA, userOneClientB, userTwoClientB].map(
					(row) =>
						getMcpEventSubscription({ db, userId: row.userId, id: row.id }),
				),
			)
		).map((row) => (row ? `${row.userId}/${row.oauthClientId}` : null))

	await expect(
		deleteMcpEventSubscriptionsForOauthClient({
			db,
			oauthClientId: 'client-a',
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toBe(1)
	expect(await remaining()).toEqual([
		null,
		'user-2/client-a',
		'user-1/client-b',
		'user-2/client-b',
	])
	await expect(
		deleteMcpEventSubscriptionsForOauthClient({
			db,
			oauthClientId: 'client-a',
		}),
	).resolves.toBe(1)
	await expect(
		deleteMcpEventSubscriptionsForUser({
			db,
			userId: ownerIdFromStored('user-2'),
		}),
	).resolves.toBe(1)
	expect(await remaining()).toEqual([null, null, 'user-1/client-b', null])
	await expect(
		deleteMcpEventSubscription({
			db,
			userId: ownerIdFromStored('user-2'),
			id: userOneClientB.id,
		}),
	).resolves.toBe(false)
	await expect(
		deleteMcpEventSubscription({
			db,
			userId: ownerIdFromStored('user-1'),
			id: userOneClientB.id,
		}),
	).resolves.toBe(true)
})
