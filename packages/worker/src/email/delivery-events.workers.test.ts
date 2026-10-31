import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { baseMessage } from './mailbox-test-helpers.ts'
import { upsertOutboundProviderIndexRow } from './outbound-provider-index.ts'
import { recordProviderEmailDeliveryEvent } from './service.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function captureD1Sql(db: D1Database) {
	const sql: Array<string> = []
	return {
		sql,
		db: new Proxy(db, {
			get(target, property, receiver) {
				if (property === 'prepare' || property === 'exec') {
					return (statement: string) => {
						sql.push(statement)
						return target[property](statement)
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	}
}

function providerEvent(input: {
	providerMessageId: string
	providerEventId: string
	status: 'delivered' | 'bounced'
	at: string
}) {
	return {
		type: `cf.email.sending.message.${input.status}`,
		source: {
			type: 'email.sending',
			zoneId: 'zone-1',
			domain: 'inbox.example.com',
		},
		payload: {
			eventId: input.providerEventId,
			messageId: input.providerMessageId,
			sender: 'user@inbox.example.com',
			recipient: 'recipient@example.net',
			terminal: true,
			delivery: { status: input.status },
		},
		metadata: {
			accountId: 'account-1',
			eventSubscriptionId: 'subscription-1',
			eventSchemaVersion: 1,
			eventTimestamp: input.at,
		},
	}
}

test('provider lifecycle resolves the thin D1 index and mutates only Mailbox', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`provider-user-${crypto.randomUUID()}`)
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const createdAt = '2026-08-03T01:00:00.000Z'
	const mailbox = mailboxRpc({ env, userId: userId })
	const message = baseMessage(userId, {
		direction: 'outbound',
		inboxId: null,
		processingStatus: 'sent',
		providerMessageId,
		sentAt: createdAt,
		createdAt,
	})
	const messageId = message.id
	await mailbox.upsertMessageGraph({ ownerId: userId, message })
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId,
		inboxId: null,
		now: createdAt,
	})

	const deliveredAt = '2026-08-03T01:02:00.000Z'
	const event = providerEvent({
		providerMessageId,
		providerEventId: `event-${crypto.randomUUID()}`,
		status: 'delivered',
		at: deliveredAt,
	})
	const capturedD1 = captureD1Sql(env.APP_DB)
	const flowEnv = { ...env, APP_DB: capturedD1.db }
	const recorded = await processCloudflareEmailDeliveryEvent({
		env: flowEnv,
		body: event,
	})
	expect(recorded).toMatchObject({
		outcome: 'recorded',
		message: {
			id: messageId,
			userId,
			deliveryStatus: 'delivered',
			deliveryStatusAt: deliveredAt,
		},
		event: { messageId, userId, eventType: 'delivered' },
	})
	expect(
		await processCloudflareEmailDeliveryEvent({ env: flowEnv, body: event }),
	).toMatchObject({ outcome: 'duplicate' })
	expect(await mailbox.getMessage({ messageId })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: deliveredAt,
	})
	expect(await mailbox.listDeliveryEvents({ messageId, limit: 10 })).toEqual([
		expect.objectContaining({
			eventType: 'delivered',
			providerMessageId,
		}),
	])
	const bouncedEventId = `event-${crypto.randomUUID()}`
	const bouncedAt = '2026-08-03T01:03:00.000Z'
	const bounced = providerEvent({
		providerMessageId,
		providerEventId: bouncedEventId,
		status: 'bounced',
		at: bouncedAt,
	})
	for (const outcome of ['recorded', 'duplicate']) {
		await expect(
			processCloudflareEmailDeliveryEvent({ env: flowEnv, body: bounced }),
		).resolves.toMatchObject({ outcome })
	}
	expect(
		await env.APP_DB.prepare(
			`SELECT provider, event_type, occurred_at
			FROM email_delivery_alert_events
			WHERE provider_event_id = ?`,
		)
			.bind(bouncedEventId)
			.first(),
	).toEqual({
		provider: 'cloudflare-email',
		event_type: 'bounced',
		occurred_at: bouncedAt,
	})

	const legacyTables = await env.APP_DB.prepare(
		`SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name IN (
			'email_threads', 'email_messages', 'email_attachments',
			'email_delivery_events'
		)`,
	).all()
	expect(legacyTables.results).toEqual([])
	expect(capturedD1.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 30_000)

test('a retry after a crash past the event write still records the bounce cooldown, once', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`provider-user-${crypto.randomUUID()}`)
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const providerEventId = `event-${crypto.randomUUID()}`
	const recipient = `bounce-${crypto.randomUUID()}@example.net`
	const createdAt = '2026-08-03T01:00:00.000Z'
	const bouncedAt = '2026-08-03T01:03:00.000Z'
	const mailbox = mailboxRpc({ env, userId })
	const message = baseMessage(userId, {
		direction: 'outbound',
		inboxId: null,
		processingStatus: 'sent',
		providerMessageId,
		sentAt: createdAt,
		createdAt,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message })
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId: message.id,
		inboxId: null,
		now: createdAt,
	})
	const event = providerEvent({
		providerMessageId,
		providerEventId,
		status: 'bounced',
		at: bouncedAt,
	})
	const body = {
		...event,
		payload: {
			...event.payload,
			recipient,
			delivery: {
				status: 'bounced',
				smtpResponse: '550 5.1.1 user unknown',
				smtpEnhancedStatusCode: '5.1.1',
			},
		},
	}
	// The first attempt saved the event, then the worker died before the
	// deliverability side effects ran.
	await expect(
		recordProviderEmailDeliveryEvent({
			env,
			providerMessageId,
			providerEventId,
			deliveryStatus: 'bounced',
			eventTimestamp: bouncedAt,
			detail: {},
		}),
	).resolves.toMatchObject({ outcome: 'recorded' })
	const cooldown = () =>
		env.APP_DB.prepare(
			`SELECT failure_count FROM email_recipient_cooldowns WHERE recipient = ?`,
		)
			.bind(recipient)
			.first()

	await expect(
		processCloudflareEmailDeliveryEvent({ env, body }),
	).resolves.toMatchObject({ outcome: 'duplicate' })
	expect(await cooldown()).toEqual({ failure_count: 1 })

	await processCloudflareEmailDeliveryEvent({ env, body })
	expect(await cooldown()).toEqual({ failure_count: 1 })
}, 30_000)

test('concurrent deliveries of one bounce apply the cooldown once', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`provider-user-${crypto.randomUUID()}`)
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const recipient = `bounce-${crypto.randomUUID()}@example.net`
	const createdAt = '2026-08-03T01:00:00.000Z'
	const mailbox = mailboxRpc({ env, userId })
	const message = baseMessage(userId, {
		direction: 'outbound',
		inboxId: null,
		processingStatus: 'sent',
		providerMessageId,
		sentAt: createdAt,
		createdAt,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message })
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId: message.id,
		inboxId: null,
		now: createdAt,
	})
	const event = providerEvent({
		providerMessageId,
		providerEventId: `event-${crypto.randomUUID()}`,
		status: 'bounced',
		at: '2026-08-03T01:03:00.000Z',
	})
	const body = {
		...event,
		payload: {
			...event.payload,
			recipient,
			delivery: {
				status: 'bounced',
				smtpResponse: '550 5.1.1 user unknown',
				smtpEnhancedStatusCode: '5.1.1',
			},
		},
	}
	const settled = await Promise.allSettled([
		processCloudflareEmailDeliveryEvent({ env, body }),
		processCloudflareEmailDeliveryEvent({ env, body }),
	])
	expect(settled.some((result) => result.status === 'fulfilled')).toBe(true)
	// A queue retry of any delivery that lost the claim.
	await processCloudflareEmailDeliveryEvent({ env, body })
	expect(
		await env.APP_DB.prepare(
			`SELECT failure_count FROM email_recipient_cooldowns WHERE recipient = ?`,
		)
			.bind(recipient)
			.first(),
	).toEqual({ failure_count: 1 })
}, 30_000)

test('a transient failure while applying the cooldown is retried, not marked applied', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`provider-user-${crypto.randomUUID()}`)
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const recipient = `bounce-${crypto.randomUUID()}@example.net`
	const createdAt = '2026-08-03T01:00:00.000Z'
	const mailbox = mailboxRpc({ env, userId })
	const message = baseMessage(userId, {
		direction: 'outbound',
		inboxId: null,
		processingStatus: 'sent',
		providerMessageId,
		sentAt: createdAt,
		createdAt,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message })
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId: message.id,
		inboxId: null,
		now: createdAt,
	})
	const event = providerEvent({
		providerMessageId,
		providerEventId: `event-${crypto.randomUUID()}`,
		status: 'bounced',
		at: '2026-08-03T01:03:00.000Z',
	})
	const body = {
		...event,
		payload: {
			...event.payload,
			recipient,
			delivery: {
				status: 'bounced',
				smtpResponse: '550 5.1.1 user unknown',
				smtpEnhancedStatusCode: '5.1.1',
			},
		},
	}
	const flakyDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (statement: string) => {
					if (statement.includes('INSERT INTO email_recipient_cooldowns')) {
						throw new Error('D1_ERROR: Network connection lost.')
					}
					return target.prepare(statement)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	await expect(
		processCloudflareEmailDeliveryEvent({
			env: { ...env, APP_DB: flakyDb },
			body,
		}),
	).rejects.toThrow('Network connection lost')
	await processCloudflareEmailDeliveryEvent({ env, body })
	expect(
		await env.APP_DB.prepare(
			`SELECT failure_count FROM email_recipient_cooldowns WHERE recipient = ?`,
		)
			.bind(recipient)
			.first(),
	).toEqual({ failure_count: 1 })
}, 30_000)

test('a failure after the cooldown write does not count the cooldown twice on retry', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`provider-user-${crypto.randomUUID()}`)
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const domain = `blocked-${crypto.randomUUID()}.example`
	const recipient = `bounce@${domain}`
	const providerKey = `provider-${crypto.randomUUID()}.example`
	await env.APP_DB.prepare(
		`INSERT INTO email_mx_lookup_cache (
			domain, provider_keys_json, mx_hosts_json, looked_up_at, expires_at
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			domain,
			JSON.stringify([providerKey]),
			JSON.stringify([`mx.${providerKey}`]),
			'2026-08-03T00:00:00.000Z',
			'2999-01-01T00:00:00.000Z',
		)
		.run()
	const createdAt = '2026-08-03T01:00:00.000Z'
	const mailbox = mailboxRpc({ env, userId })
	const message = baseMessage(userId, {
		direction: 'outbound',
		inboxId: null,
		processingStatus: 'sent',
		providerMessageId,
		sentAt: createdAt,
		createdAt,
	})
	await mailbox.upsertMessageGraph({ ownerId: userId, message })
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId: message.id,
		inboxId: null,
		now: createdAt,
	})
	const event = providerEvent({
		providerMessageId,
		providerEventId: `event-${crypto.randomUUID()}`,
		status: 'bounced',
		at: '2026-08-03T01:03:00.000Z',
	})
	const body = {
		...event,
		payload: {
			...event.payload,
			recipient,
			delivery: {
				status: 'bounced',
				smtpResponse: '550 5.7.1 rejected by Spamhaus blocklist',
				smtpEnhancedStatusCode: '5.7.1',
			},
		},
	}
	const flakyDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (statement: string) => {
					if (statement.includes('INSERT INTO email_rejecting_providers')) {
						throw new Error('D1_ERROR: Network connection lost.')
					}
					return target.prepare(statement)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	await expect(
		processCloudflareEmailDeliveryEvent({
			env: { ...env, APP_DB: flakyDb },
			body,
		}),
	).rejects.toThrow('Network connection lost')
	await processCloudflareEmailDeliveryEvent({ env, body })
	expect(
		await env.APP_DB.prepare(
			`SELECT failure_count FROM email_recipient_cooldowns WHERE recipient = ?`,
		)
			.bind(recipient)
			.first(),
	).toEqual({ failure_count: 1 })
	expect(
		await env.APP_DB.prepare(
			`SELECT rejection_count FROM email_rejecting_providers WHERE provider_key = ?`,
		)
			.bind(providerKey)
			.first(),
	).toEqual({ rejection_count: 1 })
}, 30_000)
