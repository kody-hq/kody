import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { type Mailbox } from './mailbox-do.ts'
import { baseMessage, stubFor } from './mailbox-test-helpers.ts'
import { getOutboundProviderIndexRow } from './outbound-provider-index.ts'
import { getEmailAttachmentById } from './service.ts'
import {
	type EmailSendInput,
	maxOutboundEmailAttachmentTotalBytes,
	sendOutboundEmail,
} from './outbound.ts'
import {
	quarantinedInboundReplyErrorCode,
	quarantinedInboundReplyMessage,
	QuarantinedInboundReplyError,
} from './quarantined-inbound-reply.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createMswWorkerServer } from '#worker/test-support/msw-worker-server.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { maxPlanEmailLimits, planLimits } from '#universal/plans.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

const platformBaseUrl = 'https://kody.example.com'
// User mail lives on the inbox. subdomain derived from APP_BASE_URL.
const platformDomain = 'inbox.kody.example.com'
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
const pdfAttachment = {
	filename: 'invoice.pdf',
	contentType: 'application/pdf',
	contentBase64: bytesToBase64(pdfBytes),
}

type Account = Awaited<ReturnType<typeof seedAccount>>
type SentMessage = Record<string, unknown>

async function seedAccount(
	input: {
		username?: string
		plan?: 'pro' | 'max'
		verified?: boolean
	} = {},
) {
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(accountEmail)
	const username = input.username ?? `sender-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(username) DO UPDATE SET
				email = excluded.email,
				email_verified_at = excluded.email_verified_at,
				stable_user_id = excluded.stable_user_id`,
	)
		.bind(
			username,
			accountEmail,
			'test-password-hash',
			input.verified === false ? null : new Date().toISOString(),
			userId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan: input.plan ?? 'max',
	})
	return { accountEmail, userId, from: `${username}@${platformDomain}` }
}

async function addDestinations(
	account: Account,
	destinations: Array<{ email: string; verified: boolean; isDefault: boolean }>,
) {
	const user = await env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?`,
	)
		.bind(account.userId)
		.first<{ id: number }>()
	if (!user) throw new Error('expected seeded user')
	for (const destination of destinations) {
		await env.APP_DB.prepare(
			`INSERT INTO email_notification_destinations (id, user_id, email, verified_at, is_default)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				user.id,
				destination.email,
				destination.verified ? new Date().toISOString() : null,
				destination.isDefault ? 1 : 0,
			)
			.run()
	}
}

function bindingEnv(
	send: (
		message: SentMessage,
	) => Promise<{ messageId: string | null }> = async () => ({
		messageId: 'provider-message-entitlement',
	}),
) {
	return {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: { send } as unknown as SendEmail,
	}
}

function restEnv() {
	return {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: undefined as unknown as SendEmail,
		CLOUDFLARE_ACCOUNT_ID: 'account-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'token-123',
	}
}

function sendAs(account: Account, overrides: Partial<EmailSendInput> = {}) {
	return sendOutboundEmail({
		env: bindingEnv(),
		userId: account.userId,
		accountEmail: account.accountEmail,
		recipientPolicy: 'self',
		subject: 'Hello from Kody',
		text: 'Body',
		...overrides,
	} as EmailSendInput)
}

function rejection(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
}

async function expectEntitlementLimit(
	promise: Promise<unknown>,
	details: Record<string, unknown>,
) {
	const error = await rejection(promise)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from sendOutboundEmail.')
	}
	expect(error.details).toMatchObject(details)
	return error
}

async function writeInboundMailboxMessage(
	userId: string,
	input: {
		toAddresses: Array<string>
		subject: string
		messageIdHeader: string
		classification?: 'accepted' | 'quarantined'
		classificationReason?: string | null
		updatedAt?: string
	},
) {
	const now = new Date().toISOString()
	const message = baseMessage(ownerIdFromStored(userId), {
		inboxId: null,
		fromAddress: 'recipient@example.com',
		envelopeFrom: 'recipient@example.com',
		rawSize: 0,
		receivedAt: now,
		createdAt: now,
		updatedAt: now,
		...input,
	})
	await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).upsertMessageGraph({
		ownerId: ownerIdFromStored(userId),
		message,
		attachments: [],
	})
	return message
}

async function readDailyEmailSendCounter(userId: string) {
	const result = await userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).read({
		resource: 'email_sends_per_day',
		day: utcDayKey(),
	})
	return result.outcome === 'ready' ? result.count : 0
}

async function seedDailyEmailSendCounter(userId: string, count: number) {
	const day = utcDayKey()
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(userId)),
		),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.read({ resource: 'email_sends_per_day', day })
		state.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO UPDATE SET
				count = excluded.count,
				revision = excluded.revision,
				updated_at = excluded.updated_at`,
			'email_sends_per_day',
			day,
			count,
			new Date().toISOString(),
		)
	})
}

async function listOutboundMessages(userId: string) {
	return await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).listMessages({
		direction: 'outbound',
		limit: 5,
	})
}

async function listEmailSendRollups(userId: string) {
	const { results } = await env.APP_DB.prepare(
		`SELECT user_id, metric, month, event_count, error_count,
				total_duration_ms, total_cpu_ms, total_bytes
			FROM usage_rollups
			WHERE user_id = ?1 AND metric = 'email_send'
			ORDER BY month`,
	)
		.bind(userId)
		.all()
	return results
}

function proxyDb(
	db: D1Database,
	prepare: (statement: string) => unknown,
	exec?: (statement: string) => unknown,
) {
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') return prepare
			if (property === 'exec' && exec) return exec
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

function expectSentPdf(message: SentMessage | undefined) {
	const attachments = message?.attachments as Array<Record<string, unknown>>
	expect(attachments).toHaveLength(1)
	expect(attachments[0]).toMatchObject({
		disposition: 'attachment',
		filename: 'invoice.pdf',
		type: 'application/pdf',
	})
	expect(new Uint8Array(attachments[0]?.content as Uint8Array)).toEqual(
		pdfBytes,
	)
}

test('sendOutboundEmail sends from the platform-assigned username address to the account email', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to sending.
	silenceIncidentalRuntimeWarnings()
	const account = await seedAccount()
	const sent: Array<SentMessage> = []
	const sql: Array<string> = []
	const capturedDb = proxyDb(
		env.APP_DB,
		(statement) => {
			sql.push(statement)
			return env.APP_DB.prepare(statement)
		},
		(statement) => {
			sql.push(statement)
			return env.APP_DB.exec(statement)
		},
	)

	const result = await sendAs(account, {
		env: {
			...bindingEnv(async (message) => {
				sent.push(message)
				return { messageId: 'provider-message-123' }
			}),
			APP_DB: capturedDb,
		},
	})

	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({
		to: account.accountEmail,
		from: account.from,
	})
	expect(sent[0]?.headers).toEqual({})
	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toBe('provider-message-123')
	const stored = await mailboxRpc({
		env,
		userId: ownerIdFromStored(account.userId),
	}).getMessage({
		messageId: result.message.id,
	})
	expect(stored).toMatchObject({
		direction: 'outbound',
		processingStatus: 'sent',
		providerMessageId: 'provider-message-123',
		fromAddress: account.from,
		toAddresses: [account.accountEmail],
		headers: {
			'Message-ID': result.message.messageIdHeader,
			'X-Kody-Email-Message-Id': result.message.messageIdHeader,
		},
	})
	// Outbound sends store parsed bodies only: nothing written to EMAIL_BLOBS.
	expect(stored?.rawMimeKey).toBeNull()
	// The send auto-provisioned (and referenced) the platform sender
	// identity — no self-service verify step exists.
	expect(stored?.senderIdentityId).toBeTruthy()
	const identity = await env.APP_DB.prepare(
		`SELECT user_id, email, domain, status FROM email_sender_identities WHERE id = ?`,
	)
		.bind(stored?.senderIdentityId)
		.first<Record<string, unknown>>()
	expect(identity).toEqual({
		user_id: account.userId,
		email: account.from,
		domain: platformDomain,
		status: 'verified',
	})
	const listed = await listOutboundMessages(account.userId)
	expect(listed.messages.map((message) => message.id)).toContain(
		result.message.id,
	)
	expect(sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 30_000)

test('provider acceptance survives D1 index outage and the Mailbox alarm repairs without resend', async () => {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation(() => {})
	const account = await seedAccount()
	const { userId } = account
	const providerMessageId = `provider-repair-${crypto.randomUUID()}`
	let sendCount = 0
	const unavailableIndexDb = proxyDb(env.APP_DB, (statement) =>
		statement.includes('INSERT INTO email_outbound_provider_index')
			? {
					bind: () => ({
						run: async () => {
							throw new Error('injected provider-index D1 outage')
						},
					}),
				}
			: env.APP_DB.prepare(statement),
	)
	const result = await sendAs(account, {
		env: {
			...bindingEnv(async () => {
				sendCount += 1
				return { messageId: providerMessageId }
			}),
			APP_DB: unavailableIndexDb,
		},
	})

	expect(result.status).toBe('sent')
	expect(sendCount).toBe(1)
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toBeNull()
	const mailbox = mailboxRpc({ env, userId: ownerIdFromStored(userId) })
	await expect(
		mailbox.getOutboundProviderIndexRepairStatus({
			ownerId: ownerIdFromStored(userId),
		}),
	).resolves.toMatchObject({ pendingCount: 1 })
	await runInDurableObject(
		stubFor(ownerIdFromStored(userId)),
		async (instance: Mailbox, state) => {
			state.storage.sql.exec(
				`UPDATE email_outbound_provider_index_repairs SET retry_at = ?`,
				'2026-08-03T00:00:00.000Z',
			)
			await instance.alarm()
		},
	)

	expect(sendCount).toBe(1)
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toMatchObject({ userId, messageId: result.message.id })
	await expect(
		mailbox.getOutboundProviderIndexRepairStatus({
			ownerId: ownerIdFromStored(userId),
		}),
	).resolves.toMatchObject({ pendingCount: 0 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-outbound-provider-index-persistence-failed',
		expect.objectContaining({
			messageId: result.message.id,
			providerMessageId,
			error: expect.any(Error),
		}),
	)
}, 30_000)

test('sendOutboundEmail sender gates: suspended, unverified, reserved usernames, and unconfigured platform domains', async () => {
	silenceIncidentalRuntimeWarnings()
	const suspended = await seedAccount()
	await env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), suspended.userId)
		.run()
	await expect(sendAs(suspended)).rejects.toThrow('This account is suspended')

	const unverified = await seedAccount({ verified: false })
	let bindingSendCount = 0
	await expect(
		sendAs(unverified, {
			env: bindingEnv(async () => {
				bindingSendCount += 1
				return { messageId: 'provider-message-123' }
			}),
		}),
	).rejects.toThrow('Account email must be verified before sending email.')
	expect(bindingSendCount).toBe(0)

	// A live account holding an unreserved built-in username can send.
	const blog = await seedAccount({ username: 'blog' })
	const blogSent = await sendAs(blog)
	expect(blogSent.status).toBe('sent')
	expect(blogSent.message.fromAddress).toBe(`blog@${platformDomain}`)

	// A legacy account holding a permanently reserved username cannot send.
	const reserved = await seedAccount({ username: 'kody' })
	await expect(sendAs(reserved)).rejects.toThrow(
		'Reserved usernames cannot send email',
	)

	await expect(
		// @ts-expect-error missing APP_BASE_URL exercises the unconfigured-domain runtime guard
		sendAs(blog, { env: { ...bindingEnv(), APP_BASE_URL: undefined } }),
	).rejects.toThrow('no platform email domain is configured')
})

test('sendOutboundEmail self policy: only verified destinations, one attached MIME message to every allowed to', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to the policy.
	silenceIncidentalRuntimeWarnings()
	const account = await seedAccount()
	const { accountEmail, userId } = account
	const extraEmail = `phone-${crypto.randomUUID()}@example.com`
	const pendingEmail = `pending-${crypto.randomUUID()}@example.com`
	const sent: Array<SentMessage> = []
	const sendEnv = bindingEnv(async (message) => {
		sent.push(message)
		return { messageId: `provider-destinations-${sent.length}` }
	})

	const nonSelfError = await rejection(
		sendAs(account, { env: sendEnv, to: 'someone-else@example.net' }),
	)
	// Agent mistakes (third-party `to`) must stay off Sentry as McpCallerError.
	expect(nonSelfError).toBeInstanceOf(McpCallerError)
	expect(nonSelfError).toMatchObject({
		message: expect.stringContaining(
			'emailSend only delivers to your verified email destinations',
		),
	})
	// Malformed explicit recipients are rejected instead of silently dropped
	// (a dropped value would fall back to the account email).
	const invalidError = await rejection(
		sendAs(account, { env: sendEnv, to: 'not-an-email' }),
	)
	expect(invalidError).toBeInstanceOf(McpCallerError)
	expect(invalidError).toMatchObject({
		message: 'Invalid recipient email address: not-an-email',
	})
	// Providing the own account email explicitly is allowed.
	const allowed = await sendAs(account, {
		env: sendEnv,
		to: accountEmail.toUpperCase(),
	})
	expect(allowed.status).toBe('sent')
	expect(allowed.message.toAddresses).toEqual([accountEmail])

	await addDestinations(account, [
		{ email: extraEmail, verified: true, isDefault: true },
		{ email: pendingEmail, verified: false, isDefault: false },
	])
	const omitted = await sendAs(account, { env: sendEnv })
	expect(omitted.status).toBe('sent')
	expect(omitted.message.toAddresses).toEqual([extraEmail])

	const both = await sendAs(account, {
		env: sendEnv,
		to: [accountEmail, extraEmail],
		attachments: [pdfAttachment],
	})
	expect(both.status).toBe('sent')
	expect(both.message.toAddresses).toEqual([accountEmail, extraEmail])
	expect(sent[2]?.to).toEqual([accountEmail, extraEmail])
	expectSentPdf(sent[2])

	const unverifiedError = await rejection(
		sendAs(account, { env: sendEnv, to: [accountEmail, pendingEmail] }),
	)
	expect(unverifiedError).toBeInstanceOf(McpCallerError)
	expect(unverifiedError).toMatchObject({
		message: expect.stringContaining(pendingEmail),
	})
	expect(sent).toHaveLength(3)
	expect(await readDailyEmailSendCounter(userId)).toBe(3)
})

test('sendOutboundEmail skips REST fallback when the binding succeeds or validation fails first', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to the fallback.
	silenceIncidentalRuntimeWarnings()
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, () => {
				throw new Error('REST fallback should not be called')
			}),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	const account = await seedAccount()
	let bindingSendCount = 0
	const result = await sendAs(account, {
		env: bindingEnv(async () => {
			bindingSendCount += 1
			return { messageId: null }
		}),
	})
	expect(bindingSendCount).toBe(1)
	expect(result).toMatchObject({
		status: 'sent',
		providerMessageId: null,
		error: null,
	})

	await expect(
		sendAs(await seedAccount(), { env: restEnv(), text: '   ' }),
	).rejects.toThrow('Email text or HTML body is required.')
})

test('sendOutboundEmail refuses replies to quarantined inbound mail until it is released', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const account = await seedAccount()
	let providerSends = 0
	const sendEnv = bindingEnv(async () => {
		providerSends += 1
		return { messageId: `provider-quarantine-${providerSends}` }
	})
	const quarantined = await writeInboundMailboxMessage(account.userId, {
		toAddresses: [account.accountEmail],
		subject: 'You won',
		messageIdHeader: '<quarantined@example.com>',
		classification: 'quarantined',
		classificationReason: 'DMARC failed.',
	})
	const sendsBefore = await readDailyEmailSendCounter(account.userId)

	const refused = await rejection(
		sendAs(account, {
			env: sendEnv,
			recipientPolicy: 'reply',
			replyToMessageId: quarantined.id,
			subject: 'Re: You won',
			text: 'This should not send.',
		}),
	)
	expect(refused).toBeInstanceOf(QuarantinedInboundReplyError)
	expect(refused).toMatchObject({
		code: quarantinedInboundReplyErrorCode,
		message: quarantinedInboundReplyMessage,
	})
	expect(providerSends).toBe(0)
	expect(await readDailyEmailSendCounter(account.userId)).toBe(sendsBefore)
	expect(await listOutboundMessages(account.userId)).toMatchObject({
		messages: [],
	})

	const accepted = await writeInboundMailboxMessage(account.userId, {
		toAddresses: [account.accountEmail],
		subject: 'Real note',
		messageIdHeader: '<accepted@example.com>',
		classification: 'accepted',
	})
	const acceptedReply = await sendAs(account, {
		env: sendEnv,
		recipientPolicy: 'reply',
		replyToMessageId: accepted.id,
		subject: 'Re: Real note',
		text: 'Thanks.',
	})
	expect(acceptedReply.status).toBe('sent')
	expect(providerSends).toBe(1)
	expect(await readDailyEmailSendCounter(account.userId)).toBe(sendsBefore + 1)

	const held = await writeInboundMailboxMessage(account.userId, {
		toAddresses: [account.accountEmail],
		subject: 'Maybe real',
		messageIdHeader: '<held@example.com>',
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule.',
		updatedAt: '2026-07-01T12:00:00.000Z',
	})
	const released = await mailboxRpc({
		env,
		userId: ownerIdFromStored(account.userId),
	}).setMessageClassification({
		ownerId: ownerIdFromStored(account.userId),
		messageId: held.id,
		classification: 'accepted',
		classificationReason: null,
		updatedAt: '2026-07-01T12:00:01.000Z',
	})
	expect(released).toEqual({ status: 'accepted' })
	const releasedReply = await sendAs(account, {
		env: sendEnv,
		recipientPolicy: 'reply',
		replyToMessageId: held.id,
		subject: 'Re: Maybe real',
		text: 'Released, so this can send.',
	})
	expect(releasedReply.status).toBe('sent')
	expect(releasedReply.message.toAddresses).toEqual(['recipient@example.com'])
	expect(providerSends).toBe(2)
	expect(await readDailyEmailSendCounter(account.userId)).toBe(sendsBefore + 2)
})

test('sendOutboundEmail preserves reply headers and records failed fallback sends', async () => {
	silenceIncidentalRuntimeWarnings(['cloudflare-email-api-failed'])
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const isolatedUserId = `email-outbound-isolated-user-${crypto.randomUUID()}`
	const fetchCalls: Array<Record<string, unknown>> = []
	const month = new Date().toISOString().slice(0, 7)
	const encoder = new TextEncoder()

	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				fetchCalls.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json(
					{ success: false, errors: [{ message: 'provider down' }] },
					{ status: 500 },
				)
			}),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	const account = await seedAccount()
	const { accountEmail, userId } = account
	const original = await sendAs(account, { text: 'Original body' })
	const inbound = await writeInboundMailboxMessage(userId, {
		toAddresses: [accountEmail],
		subject: 'Hello from Kody',
		messageIdHeader: '<inbound-root@example.com>',
	})

	const result = await sendAs(account, {
		env: restEnv(),
		recipientPolicy: 'reply',
		replyToMessageId: inbound.id,
		subject: 'Re: Hello from Kody',
		replyTo: 'reply@example.com',
		inReplyToHeader: inbound.messageIdHeader,
		references: ['<root@example.com>'],
	})

	expect(result.status).toBe('failed')
	expect(result.error).toBe('provider down')
	// The failed REST fallback is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
	// The recipient is always derived from the stored inbound message.
	expect(result.message.toAddresses).toEqual(['recipient@example.com'])
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]).toMatchObject({
		html: 'Body',
		to: 'recipient@example.com',
		reply_to: 'reply@example.com',
		headers: {
			'In-Reply-To': inbound.messageIdHeader,
			References: '<root@example.com>',
		},
	})
	expect(fetchCalls[0]).not.toHaveProperty('replyTo')
	expect(fetchCalls[0]?.headers).not.toHaveProperty('Message-ID')
	expect(fetchCalls[0]?.headers).not.toHaveProperty('X-Kody-Email-Message-Id')
	const stored = await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).getMessage({
		messageId: result.message.id,
	})
	expect(stored).toMatchObject({
		processingStatus: 'failed',
		error: 'provider down',
		headers: {
			'Message-ID': result.message.messageIdHeader,
			'X-Kody-Email-Message-Id': result.message.messageIdHeader,
			'In-Reply-To': inbound.messageIdHeader,
			References: '<root@example.com>',
		},
	})

	// Replying to an outbound (self) message is rejected: the reply policy
	// only binds to stored inbound mail.
	await expect(
		sendAs(account, {
			recipientPolicy: 'reply',
			replyToMessageId: original.message.id,
		}),
	).rejects.toThrow('Replying requires a stored inbound message.')

	expect(await listEmailSendRollups(userId)).toEqual([
		{
			user_id: userId,
			metric: 'email_send',
			month,
			event_count: 2,
			error_count: 1,
			total_duration_ms: expect.any(Number),
			total_cpu_ms: 0,
			total_bytes:
				encoder.encode('Original body').byteLength +
				encoder.encode('Body').byteLength,
		},
	])
	expect(await listEmailSendRollups(isolatedUserId)).toEqual([])
})

test('sendOutboundEmail sends, stores, and re-serves reply attachments', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const account = await seedAccount()
	const { userId } = account
	const inbound = await writeInboundMailboxMessage(userId, {
		toAddresses: [account.accountEmail],
		subject: 'Needs a file',
		messageIdHeader: '<inbound-attach@example.com>',
	})
	const sent: Array<SentMessage> = []

	const result = await sendAs(account, {
		env: bindingEnv(async (message) => {
			sent.push(message)
			return { messageId: 'provider-attach-1' }
		}),
		recipientPolicy: 'reply',
		replyToMessageId: inbound.id,
		subject: 'Re: Needs a file',
		text: 'File attached.',
		attachments: [pdfAttachment],
	})

	expect(result.status).toBe('sent')
	// The binding receives raw bytes (string content would be treated as
	// raw text, not base64).
	expect(sent).toHaveLength(1)
	expectSentPdf(sent[0])

	// The attachment is stored as its own R2 object and stays readable via
	// the normal attachment read path.
	const mailbox = mailboxRpc({ env, userId: ownerIdFromStored(userId) })
	const stored = await mailbox.listAttachmentsForMessage({
		messageId: result.message.id,
	})
	expect(stored).toHaveLength(1)
	expect(stored[0]).toMatchObject({
		filename: 'invoice.pdf',
		contentType: 'application/pdf',
		disposition: 'attachment',
		size: pdfBytes.byteLength,
		storageKind: 'external',
	})
	const storageKey = stored[0]?.storageKey
	expect(storageKey).toContain(`email-attachment:v1:${userId}/`)
	const loaded = await getEmailAttachmentById({
		env,
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		userId: ownerIdFromStored(userId),
		attachmentId: stored[0]!.id,
	})
	expect(loaded?.contentBase64).toBe(bytesToBase64(pdfBytes))

	// Usage bytes include the attachment payload.
	const rollups = await listEmailSendRollups(userId)
	expect(rollups[0]).toMatchObject({
		total_bytes:
			new TextEncoder().encode('File attached.').byteLength +
			pdfBytes.byteLength,
	})

	// Deleting the message removes the external attachment blob too.
	await mailbox.deleteMessageWithBlobs({
		ownerId: ownerIdFromStored(userId),
		messageId: result.message.id,
	})
	expect(await env.EMAIL_BLOBS.get(storageKey!)).toBeNull()
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: result.message.id }),
	).toEqual([])
})

test('sendOutboundEmail passes base64 attachments to the REST fallback', async () => {
	const account = await seedAccount()
	const contentBase64 = bytesToBase64(new TextEncoder().encode('name,total'))
	const fetchCalls: Array<Record<string, unknown>> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				fetchCalls.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'rest-attach-1' },
				})
			}),
		],
		{ onUnhandledFrame: 'bypass' },
	)

	const result = await sendAs(account, {
		env: restEnv(),
		attachments: [
			{ filename: 'report.csv', contentType: 'text/csv', contentBase64 },
		],
	})

	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toBe('rest-attach-1')
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.attachments).toEqual([
		{
			content: contentBase64,
			filename: 'report.csv',
			type: 'text/csv',
			disposition: 'attachment',
		},
	])
})

test('sendOutboundEmail rejects invalid and oversized attachments', async () => {
	const account = await seedAccount()
	const attach = (filename: string, contentBase64: string) =>
		sendAs(account, {
			attachments: [
				{ filename, contentType: 'application/octet-stream', contentBase64 },
			],
		})
	// Attachments whose base64 length alone exceeds the 5 MiB hard cap are
	// rejected before any decoding (no entitlement lookup, no allocation).
	const hardCapBase64Length = Math.ceil(
		((maxOutboundEmailAttachmentTotalBytes + 3) * 4) / 3,
	)
	const rejected: Array<[string, string, string]> = [
		[
			'broken.bin',
			'!!not-base64!!',
			'Attachment content must be valid base64: broken.bin',
		],
		[
			'../secret.txt',
			bytesToBase64(new TextEncoder().encode('nope')),
			'Attachment filename is not allowed: ../secret.txt',
		],
		[
			'giant.bin',
			'A'.repeat(hardCapBase64Length),
			'exceed the 5 MiB combined limit',
		],
	]
	for (const [filename, contentBase64, message] of rejected) {
		await expect(attach(filename, contentBase64)).rejects.toThrow(message)
	}

	// Attachments put the message under the per-message email_message_bytes
	// cap that body-only sends are not subject to.
	await expectEntitlementLimit(
		attach(
			'huge.bin',
			bytesToBase64(new Uint8Array(maxPlanEmailLimits.email_message_bytes + 1)),
		),
		{ resource: 'email_message_bytes' },
	)

	// None of the failures consumed the daily send quota or stored a message.
	expect(await readDailyEmailSendCounter(account.userId)).toBe(0)
	expect(await listOutboundMessages(account.userId)).toMatchObject({
		messages: [],
	})
}, 30_000)

test('sendOutboundEmail meters email_sends_per_day for pro users: refund on storage failure, increment, then deny with or without account email', async () => {
	const account = await seedAccount({ plan: 'pro' })
	const { userId } = account
	const limit = planLimits.pro.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric pro email limit.')
	expect(await readDailyEmailSendCounter(userId)).toBe(0)
	await seedDailyEmailSendCounter(userId, limit - 1)

	await expect(sendAs(account, { threadId: 'missing-thread' })).rejects.toThrow(
		'Email thread was not found: missing-thread',
	)
	expect(await readDailyEmailSendCounter(userId)).toBe(limit - 1)
	expect(await listOutboundMessages(userId)).toMatchObject({ messages: [] })

	// Without the refund, this send would hit the plan limit.
	const result = await sendAs(account)
	expect(result.status).toBe('sent')
	expect(await readDailyEmailSendCounter(userId)).toBe(limit)

	const error = await expectEntitlementLimit(sendAs(account), {
		code: 'entitlement_limit_exceeded',
		resource: 'email_sends_per_day',
		plan: 'pro',
		limit,
		current: limit,
	})
	expect(error.message).toContain(`at most ${limit} email sends per day`)
	// Package subscription contexts pass an empty account email; the plan
	// limit must still apply (no fallback-limit bypass).
	await expectEntitlementLimit(sendAs(account, { accountEmail: '' }), {
		resource: 'email_sends_per_day',
		plan: 'pro',
		limit,
	})
}, 30_000)

test('sendOutboundEmail caps max-plan users at the email daily backstop', async () => {
	const account = await seedAccount({ plan: 'max' })
	const backstop = maxPlanEmailLimits.email_sends_per_day
	await seedDailyEmailSendCounter(account.userId, backstop - 1)
	// One send left under the backstop succeeds...
	expect((await sendAs(account)).status).toBe('sent')
	expect(await readDailyEmailSendCounter(account.userId)).toBe(backstop)

	// ...and the next one is denied: max is not uncapped for email.
	await expectEntitlementLimit(sendAs(account), {
		code: 'entitlement_limit_exceeded',
		resource: 'email_sends_per_day',
		plan: 'max',
		limit: backstop,
		current: backstop,
	})
	expect(await readDailyEmailSendCounter(account.userId)).toBe(backstop)
}, 30_000)
