import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, test } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	maxPlanEmailLimits,
	planLimits,
	type PlanName,
} from '#universal/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { handleInboundEmail } from './inbound.ts'
import { maxSurvivableInboundRawBytes } from './parser.ts'
import { mailboxRpc } from './mailbox-client.ts'
import type { Mailbox } from './mailbox-do.ts'
import { stubFor } from './mailbox-test-helpers.ts'
import { maxDetailedEmailRejectionEventsPerDay } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const appBaseUrl = 'https://kody.example.com'

beforeEach(() => {
	silenceExpectedConsoleWarns(['inbound-email-sender-unverified'])
})

async function seedAccount(label: string, plan: PlanName) {
	const username = `${label}-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, 'test-password-hash', ?, ?)`,
	)
		.bind(username, email, new Date().toISOString(), userId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan,
	})
	return { address: `${username}@inbox.kody.example.com`, userId }
}

function messageFor(address: string) {
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Entitlement check',
			`Message-ID: <entitlement-${crypto.randomUUID()}@example.net>`,
			'',
			'Body.',
		].join('\r\n'),
	})
}

async function seedReceiveCount(userId: string, count: number) {
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(userId)),
		),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.read({
			resource: 'email_receives_per_day',
			day: utcDayKey(),
		})
		state.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO UPDATE SET
				count = excluded.count,
				revision = excluded.revision,
				updated_at = excluded.updated_at`,
			'email_receives_per_day',
			utcDayKey(),
			count,
			new Date().toISOString(),
		)
	})
}

async function readReceiveCount(userId: string) {
	const result = await userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).read({
		resource: 'email_receives_per_day',
		day: utcDayKey(),
	})
	return result.outcome === 'ready' ? result.count : 0
}

async function readRejections(userId: string) {
	const events = await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).listDeliveryEvents({
		limit: 100,
	})
	const rejected = events
		.filter((event) => event.eventType === 'rejected')
		.map((event) => JSON.parse(event.detailJson) as Record<string, unknown>)
	return {
		aggregate: rejected.find((detail) => detail['aggregate'] === true),
		detailed: rejected.filter((detail) => detail['aggregate'] !== true),
	}
}

async function seedStoredMailboxMessages(userId: string, count: number) {
	await mailboxRpc({ env, userId: ownerIdFromStored(userId) }).countMessages({})
	await runInDurableObject(
		stubFor(ownerIdFromStored(userId)),
		async (_instance: Mailbox, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE seq(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
			)
			INSERT INTO email_messages (
				id, direction, processing_status, created_at, updated_at
			)
			SELECT ? || n, 'inbound', 'stored', ?, ? FROM seq`,
				count,
				`seed-${crypto.randomUUID()}-`,
				new Date().toISOString(),
				new Date().toISOString(),
			)
		},
	)
}

function captureD1Sql(db: D1Database) {
	const sql: Array<string> = []
	return {
		sql,
		db: new Proxy(db, {
			get(target, property, receiver) {
				if (property === 'prepare') {
					return (statement: string) => {
						sql.push(statement)
						return target.prepare(statement)
					}
				}
				if (property === 'exec') {
					return (statement: string) => {
						sql.push(statement)
						return target.exec(statement)
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	}
}

test('daily receive caps reject through the Mailbox audit path, bounding detail but not the aggregate', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const freeLimit = planLimits.free.maxEmailReceivesPerDay
	if (freeLimit === null) throw new Error('Expected a free receive limit.')
	const plans = [
		{
			plan: 'free',
			limit: freeLimit,
			attempts: maxDetailedEmailRejectionEventsPerDay + 3,
		},
		{
			plan: 'max',
			limit: maxPlanEmailLimits.email_receives_per_day,
			attempts: 1,
		},
	] as const
	for (const { plan, limit, attempts } of plans) {
		const account = await seedAccount(`quota-${plan}`, plan)
		await seedReceiveCount(account.userId, limit)
		for (let index = 0; index < attempts; index += 1) {
			const message = messageFor(account.address)
			await handleInboundEmail(message, { ...env, APP_BASE_URL: appBaseUrl })
			expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
		}
		expect(
			await mailboxRpc({
				env,
				userId: ownerIdFromStored(account.userId),
			}).listMessages({
				limit: 10,
			}),
		).toMatchObject({ messages: [] })
		const rejections = await readRejections(account.userId)
		expect(rejections.detailed).toHaveLength(
			Math.min(attempts, maxDetailedEmailRejectionEventsPerDay),
		)
		expect(rejections.detailed[0]).toMatchObject({
			reason: `Daily receive cap ${limit} reached.`,
			phase: 'entitlement',
		})
		expect(rejections.aggregate).toMatchObject({
			aggregate: true,
			count: attempts,
			last_phase: 'entitlement',
		})
	}

	const legacyTables = await env.APP_DB.prepare(
		`SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name IN (
			'email_threads', 'email_messages', 'email_delivery_events'
		)`,
	).all()
	expect(legacyTables.results).toEqual([])
}, 60_000)

test('free-plan Mailbox count, storage, and size limits reject before charge while under-quota stores', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const captured = captureD1Sql(env.APP_DB)
	const inboundEnv = { ...env, APP_DB: captured.db, APP_BASE_URL: appBaseUrl }

	const overLimits: Array<{
		label: string
		phase: string
		prepare: (userId: string, message: ForwardableEmailMessage) => Promise<void>
	}> = [
		{
			label: 'count-cap',
			phase: 'entitlement',
			prepare: (userId) =>
				seedStoredMailboxMessages(
					userId,
					planLimits.free.maxStoredEmailMessages,
				),
		},
		{
			label: 'storage-cap',
			phase: 'entitlement',
			prepare: async (userId) => {
				await userMeterRpc({
					env,
					userId: ownerIdFromStored(userId),
				}).setStorageBytes({
					bytes: planLimits.free.maxStorageBytes,
					updatedAt: new Date().toISOString(),
				})
			},
		},
		{
			label: 'size-cap',
			phase: 'size',
			prepare: async (_userId, message) => {
				Object.defineProperty(message, 'rawSize', {
					value: maxSurvivableInboundRawBytes + 1,
				})
			},
		},
	]
	for (const { label, phase, prepare } of overLimits) {
		const account = await seedAccount(label, 'free')
		const message = messageFor(account.address)
		await prepare(account.userId, message)
		await handleInboundEmail(message, inboundEnv)
		expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
		expect(await readReceiveCount(account.userId)).toBe(0)
		expect((await readRejections(account.userId)).detailed[0]).toMatchObject({
			phase,
		})
	}

	const acceptedAccount = await seedAccount('under-cap', 'free')
	const accepted = messageFor(acceptedAccount.address)
	await handleInboundEmail(accepted, inboundEnv)
	expect(accepted.rejectedReason).toBeNull()
	expect(
		await mailboxRpc({
			env,
			userId: ownerIdFromStored(acceptedAccount.userId),
		}).listMessages({
			limit: 10,
		}),
	).toMatchObject({
		messages: [expect.objectContaining({ direction: 'inbound' })],
	})
	expect(await readReceiveCount(acceptedAccount.userId)).toBe(1)
	expect(captured.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 60_000)

test('UserMeter inbound claim and consume roll back together on claim insert failure', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const account = await seedAccount('meter-atomic', 'free')
	// Use "today" so read()'s default wall-clock retention sweep does not
	// delete the seeded counter (14-day window).
	const now = new Date()
	const day = utcDayKey(now)
	const updatedAt = now.toISOString()
	const deliveryId = `email-inbound-delivery:atomic-${crypto.randomUUID()}`
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(account.userId)),
		),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		await instance.initialize({
			resource: 'email_receives_per_day',
			day,
			count: 0,
			updatedAt,
		})
		const sql = state.storage.sql
		const originalExec = sql.exec.bind(sql)
		sql.exec = ((query: string, ...bindings: Array<unknown>) => {
			if (query.includes('INSERT INTO inbound_delivery_claims')) {
				throw new Error('injected inbound claim insert failure')
			}
			return originalExec(query, ...bindings)
		}) as typeof sql.exec
		await expect(
			instance.consumeInboundDelivery({
				deliveryId,
				resource: 'email_receives_per_day',
				day,
				limit: planLimits.free.maxEmailReceivesPerDay,
				updatedAt,
			}),
		).rejects.toThrow('injected inbound claim insert failure')
		sql.exec = originalExec
		expect(
			await instance.read({
				resource: 'email_receives_per_day',
				day,
				now: updatedAt,
			}),
		).toMatchObject({ outcome: 'ready', count: 0 })
		expect(
			sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count
					FROM inbound_delivery_claims
					WHERE delivery_id = ?`,
					deliveryId,
				)
				.toArray()[0]?.count,
		).toBe(0)
		await expect(
			instance.consumeInboundDelivery({
				deliveryId,
				resource: 'email_receives_per_day',
				day,
				limit: planLimits.free.maxEmailReceivesPerDay,
				updatedAt,
			}),
		).resolves.toMatchObject({ consumed: true, replayed: false, count: 1 })
	})
})
