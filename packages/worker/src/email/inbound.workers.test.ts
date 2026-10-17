import { env } from 'cloudflare:workers'
import { beforeEach, expect, test } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { maxPlanEmailLimits, planLimits } from '#universal/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import {
	getEmailMessageWithAttachmentsById,
	loadEmailAttachmentContent,
	RetryableInboundStorageError,
} from './service.ts'
import { listSystemEmailMessages } from './system-email-graph-store.ts'
import {
	createForwardableEmailMessage,
	createLargeMultipartRelatedInlinePngMessage,
	inboundInlinePngContentId,
	inboundInlinePngFilename,
} from './test-fixtures.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const platformDomain = 'inbox.kody.example.com'

beforeEach(() => {
	// Fixture mail has no Authentication-Results, so sender classification
	// runs nothing and logs. Storage under test still completes.
	silenceExpectedConsoleWarns(['inbound-email-sender-unverified'])
})

async function seedAccount(label: string, input: { verified?: boolean } = {}) {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `${label}-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, 'test-password-hash', ?, ?)`,
	)
		.bind(
			username,
			email,
			input.verified === false ? null : new Date().toISOString(),
			userId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan: 'max',
	})
	return { userId, username, address: `${username}@${platformDomain}` }
}

function inboundEnv(overrides: Partial<typeof env> = {}) {
	return { ...env, APP_BASE_URL: 'https://kody.example.com', ...overrides }
}

function inboundMessage(input: {
	address: string
	messageId: string
	withAttachment?: boolean
}) {
	const raw = input.withAttachment
		? [
				'From: Sender <sender@example.net>',
				`To: ${input.address}`,
				'Subject: Mailbox cutover',
				`Message-ID: <${input.messageId}>`,
				'Content-Type: multipart/mixed; boundary="cutover-boundary"',
				'',
				'--cutover-boundary',
				'Content-Type: text/plain; charset="utf-8"',
				'',
				'Mailbox body.',
				'--cutover-boundary',
				'Content-Type: text/plain; name="note.txt"',
				'Content-Disposition: attachment; filename="note.txt"',
				'',
				'Attachment bytes.',
				'--cutover-boundary--',
			].join('\r\n')
		: [
				'From: Sender <sender@example.net>',
				`To: ${input.address}`,
				'Subject: Rejected before claim',
				`Message-ID: <${input.messageId}>`,
				'',
				'Body.',
			].join('\r\n')
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: input.address,
		raw,
	})
}

async function readDailyReceives(
	userId: string,
	day = new Date().toISOString().slice(0, 10),
) {
	return await userMeterRpc({ env, userId: ownerIdFromStored(userId) }).read({
		resource: 'email_receives_per_day',
		day,
	})
}

async function listUserMessages(userId: string) {
	return (
		await mailboxRpc({ env, userId: ownerIdFromStored(userId) }).listMessages({
			limit: 10,
		})
	).messages
}

async function getStoredInbound(userId: string) {
	const mailbox = mailboxRpc({ env, userId: ownerIdFromStored(userId) })
	const page = await mailbox.listMessages({ direction: 'inbound', limit: 10 })
	expect(page.messages).toHaveLength(1)
	const stored = await mailbox.getMessage({ messageId: page.messages[0]!.id })
	if (!stored?.rawMimeKey) throw new Error('Expected a stored raw MIME key.')
	const rawBlob = await env.EMAIL_BLOBS.get(stored.rawMimeKey)
	if (!rawBlob) throw new Error('Expected the raw MIME blob in EMAIL_BLOBS.')
	return { listed: page.messages[0]!, stored, rawBlob }
}

async function loadStoredAttachments(userId: string, messageId: string) {
	const attachments = await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).listAttachmentsForMessage({ messageId })
	const loaded = await getEmailMessageWithAttachmentsById({
		env,
		db: env.APP_DB,
		userId: ownerIdFromStored(userId),
		messageId,
	})
	if (!attachments[0] || !loaded) throw new Error('Expected an attachment.')
	const content = await loadEmailAttachmentContent({
		blobs: env.EMAIL_BLOBS,
		attachment: attachments[0],
		message: loaded.message,
	})
	return { attachments, content }
}

test('USER inbound commits graph, attachments, terminal event, and retry only in Mailbox', async () => {
	const { userId, address } = await seedAccount('inbound')
	const messageIdHeader = `cutover-${crypto.randomUUID()}@example.net`
	const input = { address, messageId: messageIdHeader, withAttachment: true }
	const sql: Array<string> = []
	const capturedDb = new Proxy(env.APP_DB, {
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
	})

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const message = inboundMessage(input)
		await handleInboundEmail(message, inboundEnv({ APP_DB: capturedDb }))
		expect(message.rejectedReason).toBeNull()
	}

	const mailbox = mailboxRpc({ env, userId: ownerIdFromStored(userId) })
	const messages = await listUserMessages(userId)
	expect(messages).toEqual([
		expect.objectContaining({
			direction: 'inbound',
			messageIdHeader: `<${messageIdHeader}>`,
			subject: 'Mailbox cutover',
			processingStatus: 'stored',
		}),
	])
	const stored = messages[0]!
	expect(
		await mailbox.listAttachmentsForMessage({ messageId: stored.id }),
	).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			filename: 'note.txt',
			storageKind: 'raw-mime',
		}),
	])
	expect(
		await mailbox.listDeliveryEvents({ messageId: stored.id, limit: 10 }),
	).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			eventType: 'received',
			state: 'received',
		}),
	])
	expect(await env.EMAIL_BLOBS.get(stored.rawMimeKey!)).not.toBeNull()
	expect(await readDailyReceives(userId)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})

	const legacyTables = await env.APP_DB.prepare(
		`SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name IN (
			'email_threads', 'email_messages', 'email_attachments',
			'email_delivery_events'
		)`,
	).all()
	expect(legacyTables.results).toEqual([])
	expect(sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 30_000)

test('preclaim USER rejection audit is bounded in Mailbox without D1 graph rows', async () => {
	const { userId, address } = await seedAccount('unverified', {
		verified: false,
	})
	const message = inboundMessage({
		address,
		messageId: `reject-${crypto.randomUUID()}@example.net`,
	})
	await handleInboundEmail(message, inboundEnv())
	expect(message.rejectedReason).toBe('Account email is not verified.')

	const events = await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).listDeliveryEvents({
		limit: 10,
	})
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ eventType: 'rejected', messageId: null }),
		]),
	)
	const detailedEvent = events.find((event) =>
		event.detailJson.includes('"phase":"account-verification"'),
	)
	expect(JSON.parse(detailedEvent?.detailJson ?? '{}')).toMatchObject({
		reason: 'Account email is not verified.',
		phase: 'account-verification',
	})
}, 30_000)

test('USER inbound R2 failure retries idempotently without a second quota charge', async () => {
	const { userId, address } = await seedAccount('inbound-r2')
	const input = {
		address,
		messageId: `r2-retry-${crypto.randomUUID()}@example.net`,
		withAttachment: true,
	}
	const failingBlobs = new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'put') {
				return async () => {
					throw new Error('simulated R2 outage')
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	const first = inboundMessage(input)
	await expect(
		handleInboundEmail(first, inboundEnv({ EMAIL_BLOBS: failingBlobs })),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(first.rejectedReason).toBeNull()
	expect(await readDailyReceives(userId)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})
	expect(await listUserMessages(userId)).toEqual([])

	const retry = inboundMessage(input)
	await handleInboundEmail(retry, inboundEnv())
	expect(retry.rejectedReason).toBeNull()
	expect(await listUserMessages(userId)).toHaveLength(1)
	expect(await readDailyReceives(userId)).toMatchObject({
		outcome: 'ready',
		count: 1,
	})
}, 30_000)

test('pointer-only USER retry after midnight enforces the current quota day', async () => {
	const oldNow = new Date('2026-07-22T23:59:00.000Z')
	const retryNow = new Date('2026-07-23T00:01:00.000Z')
	const { userId, username, address } = await seedAccount('midnight')
	await env.APP_DB.prepare(`UPDATE orgs SET plan = 'free' WHERE id = ?`)
		.bind(userId)
		.run()
	const provisioned = await ensureDefaultEmailInbox({
		db: env.APP_DB,
		userId,
		actorPersonId: userId,
		username,
		domain: platformDomain,
	})
	if (!provisioned) throw new Error('Expected provisioned default inbox.')
	const buildDelivery = (quotaDay: string, now: Date) =>
		buildInboundDelivery({
			userId: ownerIdFromStored(userId),
			inboxId: provisioned.inbox.id,
			recipient: address,
			envelopeFrom: 'sender@example.net',
			rawMime: 'byte-identical mail spanning the quota-day boundary',
			quotaDay,
			now,
		})
	const oldPointer = await buildDelivery('2026-07-22', oldNow)
	const retryDelivery = await buildDelivery('2026-07-23', retryNow)
	const authority = createUserInboundDeliveryAuthority({
		env,
		userId: ownerIdFromStored(userId),
	})
	await authority.claimWindow(oldPointer, oldNow)
	const receiveLimit = planLimits.free.maxEmailReceivesPerDay
	if (receiveLimit == null) throw new Error('Expected finite receive limit.')
	await userMeterRpc({ env, userId: ownerIdFromStored(userId) }).initialize({
		resource: 'email_receives_per_day',
		day: '2026-07-23',
		count: receiveLimit,
		updatedAt: retryNow.toISOString(),
	})

	await expect(
		authority.charge({
			delivery: retryDelivery,
			plan: 'free',
			limit: receiveLimit,
			now: retryNow,
		}),
	).rejects.toBeInstanceOf(EntitlementLimitError)
	expect(await listUserMessages(userId)).toEqual([])
}, 30_000)

test('account deletion fence blocks the complete USER inbound write boundary', async () => {
	const { userId, address } = await seedAccount('deleting')
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	const message = inboundMessage({
		address,
		messageId: `deletion-fence-${crypto.randomUUID()}@example.net`,
		withAttachment: true,
	})

	await expect(
		handleInboundEmail(message, inboundEnv()),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		await mailboxRpc({ env, userId: ownerIdFromStored(userId) }).countMailbox(),
	).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
	expect(
		await env.EMAIL_BLOBS.list({ prefix: `email-raw:v1:${userId}/` }),
	).toMatchObject({ objects: [] })
}, 30_000)

test('max-plan plus-tag inbox stores a large multipart/related inline PNG', async () => {
	const { userId, username } = await seedAccount('large-mime')
	const taggedAddress = `${username}+kody@${platformDomain}`
	const messageIdHeader = `large-related-${crypto.randomUUID()}@example.net`
	const formerParserCeilingBytes = 512 * 1024
	const message = createLargeMultipartRelatedInlinePngMessage({
		from: 'sender@example.net',
		to: taggedAddress,
		subject: 'Large related budget alert',
		messageId: messageIdHeader,
		minRawBytes: 575 * 1024,
	})
	expect(message.rawSize).toBeGreaterThan(formerParserCeilingBytes)
	expect(message.rawSize).toBeLessThanOrEqual(
		maxPlanEmailLimits.email_message_bytes,
	)

	await handleInboundEmail(message, inboundEnv())
	expect(message.rejectedReason).toBeNull()

	const { listed, stored, rawBlob } = await getStoredInbound(userId)
	expect(listed).toMatchObject({
		direction: 'inbound',
		subject: 'Large related budget alert',
		messageIdHeader: `<${messageIdHeader}>`,
		toAddresses: [taggedAddress],
		processingStatus: 'stored',
		classification: 'accepted',
		rawSize: message.rawSize,
	})
	expect(stored.inboxId).toBeTruthy()
	expect(stored.htmlBody).toContain(`cid:${inboundInlinePngContentId}`)
	expect(rawBlob.size).toBe(message.rawSize)

	const { attachments, content } = await loadStoredAttachments(
		userId,
		stored.id,
	)
	expect(attachments).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			filename: inboundInlinePngFilename,
			contentType: 'image/png',
			contentId: `<${inboundInlinePngContentId}>`,
			disposition: 'inline',
			storageKind: 'raw-mime',
		}),
	])
	expect(content.content).not.toBeNull()
	expect(content.contentBase64?.startsWith('iVBORw0KGgo')).toBe(true)
	expect(content.size).toBeGreaterThan(0)

	const inboundMessagePrefix = 'email-inbound-message:'
	expect(stored.id.startsWith(inboundMessagePrefix)).toBe(true)
	const deliveryId = `email-inbound-delivery:${stored.id.slice(inboundMessagePrefix.length)}`
	expect(
		await createUserInboundDeliveryAuthority({
			env,
			userId: ownerIdFromStored(userId),
		}).get(deliveryId),
	).toMatchObject({
		state: 'received',
		messageId: stored.id,
		subscriptionEffectState: 'complete',
	})

	expect(await listSystemEmailMessages({ db: env.APP_DB, limit: 10 })).toEqual(
		[],
	)
	expect(
		await readDailyReceives(
			userId,
			(stored.receivedAt ?? stored.createdAt).slice(0, 10),
		),
	).toMatchObject({ outcome: 'ready', count: 1 })
}, 60_000)

test('max-plan inbox stores oversized related mail by omitting the large part', async () => {
	const { userId, address } = await seedAccount('omit-mime')
	const messageIdHeader = `omit-related-${crypto.randomUUID()}@example.net`
	const message = createLargeMultipartRelatedInlinePngMessage({
		from: 'sender@example.net',
		to: address,
		subject: 'Oversized related budget alert',
		messageId: messageIdHeader,
		minRawBytes: maxPlanEmailLimits.email_message_bytes + 64 * 1024,
	})
	expect(message.rawSize).toBeGreaterThan(
		maxPlanEmailLimits.email_message_bytes,
	)

	await handleInboundEmail(message, inboundEnv())
	expect(message.rejectedReason).toBeNull()

	const { listed, stored, rawBlob } = await getStoredInbound(userId)
	expect(listed).toMatchObject({
		direction: 'inbound',
		subject: 'Oversized related budget alert',
		messageIdHeader: `<${messageIdHeader}>`,
		processingStatus: 'stored',
		classification: 'accepted',
	})
	expect(stored.htmlBody).toContain('Budget alert')
	expect(stored.rawSize).toBeLessThanOrEqual(
		maxPlanEmailLimits.email_message_bytes,
	)
	expect(rawBlob.size).toBeLessThanOrEqual(
		maxPlanEmailLimits.email_message_bytes,
	)
	expect(rawBlob.size).toBeLessThan(message.rawSize)
	const rawText = await rawBlob.text()
	expect(rawText).toContain('X-Kody-Inbound-Reduced: 1')
	expect(rawText).toContain(`X-Kody-Original-Size: ${message.rawSize}`)

	const { attachments, content } = await loadStoredAttachments(
		userId,
		stored.id,
	)
	expect(attachments).toEqual([
		expect.objectContaining({
			messageId: stored.id,
			filename: inboundInlinePngFilename,
			contentType: 'image/png',
			storageKind: 'unavailable',
		}),
	])
	expect(content.content).toBeNull()
	expect(content.contentBase64).toBeNull()
	expect(
		await readDailyReceives(
			userId,
			(stored.receivedAt ?? stored.createdAt).slice(0, 10),
		),
	).toMatchObject({ outcome: 'ready', count: 1 })
}, 60_000)

async function seedTeamOrg(
	plan: 'free' | 'pro',
	options?: { stripePlan?: 'pro' | 'standard' | null },
) {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const slug = `team-${crypto.randomUUID().slice(0, 8)}`
	const orgId = testStableUserIdFromEmail(`${slug}@teams.example`)
	const now = new Date().toISOString()
	const stripePlan = options?.stripePlan ?? null
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, stripe_plan, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(orgId, slug, plan, stripePlan, now, now)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO handles (handle, user_id, org_id, created_at)
		 VALUES (?, NULL, ?, ?)`,
	)
		.bind(slug, orgId, now)
		.run()
	return { orgId, slug, address: `${slug}@${platformDomain}` }
}

test('a paid team-org slug routes inbound mail to that org', async () => {
	const { orgId, slug } = await seedTeamOrg('pro')
	const taggedAddress = `${slug}+billing@${platformDomain}`
	const message = inboundMessage({
		address: taggedAddress,
		messageId: `team-paid-${crypto.randomUUID()}@example.net`,
	})

	await handleInboundEmail(message, inboundEnv())

	expect(message.rejectedReason).toBeNull()
	const messages = await listUserMessages(orgId)
	expect(messages).toHaveLength(1)
	expect(messages[0]?.toAddresses).toContain(taggedAddress)
}, 30_000)

test('a free team org rejects inbound mail', async () => {
	const { orgId, address } = await seedTeamOrg('free')
	const message = inboundMessage({
		address,
		messageId: `team-free-${crypto.randomUUID()}@example.net`,
	})

	await handleInboundEmail(message, inboundEnv())

	expect(message.rejectedReason).toBe('Team email requires a paid plan.')
	expect(await listUserMessages(orgId)).toEqual([])
}, 30_000)

test('a stripe-paid team with free orgs.plan still receives mail', async () => {
	const { orgId, address } = await seedTeamOrg('free', { stripePlan: 'pro' })
	const message = inboundMessage({
		address,
		messageId: `team-stripe-${crypto.randomUUID()}@example.net`,
	})

	await handleInboundEmail(message, inboundEnv())

	expect(message.rejectedReason).toBeNull()
	expect(await listUserMessages(orgId)).toHaveLength(1)
}, 30_000)
