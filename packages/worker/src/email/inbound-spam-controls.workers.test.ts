import { env } from 'cloudflare:workers'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { expect, test, vi } from 'vitest'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import type * as PackageSubscriptionsModule from './package-subscriptions.ts'
import { handleInboundEmail } from './inbound.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { upsertEmailSenderRule } from './sender-rules.ts'
import { systemEmailOwnerId } from './system-email.ts'
import { listSystemEmailMessages } from './system-email-graph-store.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'
const systemDomain = 'kody.example.com'

const packageSubscriptionMocks = vi.hoisted(() => ({
	dispatchInboundEmailSubscriptionEvents: vi.fn<
		typeof PackageSubscriptionsModule.dispatchInboundEmailSubscriptionEvents
	>(async () => []),
	dispatchSystemInboundEmailSubscriptionEvents: vi.fn<
		typeof PackageSubscriptionsModule.dispatchSystemInboundEmailSubscriptionEvents
	>(async () => []),
}))

vi.mock('./package-subscriptions.ts', async () => {
	const actual = await vi.importActual<typeof PackageSubscriptionsModule>(
		'./package-subscriptions.ts',
	)
	return {
		...actual,
		dispatchInboundEmailSubscriptionEvents:
			packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents,
		dispatchSystemInboundEmailSubscriptionEvents:
			packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	}
})

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedVerifiedAccount(prefix: string) {
	const username = `${prefix}-${crypto.randomUUID().slice(0, 8)}`
	const email = `${prefix}-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   username = excluded.username,
			   email_verified_at = excluded.email_verified_at,
			   stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
			   updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			new Date().toISOString(),
			userId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan: 'max',
	})
	return { userId, address: `${username}@${platformDomain}` }
}

async function readUserDailyReceiveCount(userId: string) {
	const result = await userMeterRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).read({
		resource: 'email_receives_per_day',
		day: new Date().toISOString().slice(0, 10),
	})
	return result.outcome === 'ready' ? result.count : 0
}

function dmarcFailAuthResults() {
	return 'mx.cloudflare.net; dmarc=fail (p=reject) header.from=example.net; spf=fail smtp.mailfrom=example.net; dkim=fail header.d=example.net'
}

function createWaitUntilContext() {
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	return { ctx, waitUntilPromises }
}

function mail(
	from: string,
	to: string,
	subject: string,
	extraHeaders: Array<string> = [],
) {
	return createForwardableEmailMessage({
		from,
		to,
		raw: [
			`From: <${from}>`,
			`To: ${to}`,
			`Subject: ${subject}`,
			`Message-ID: <${crypto.randomUUID()}@example.net>`,
			...extraHeaders,
			'',
			'Body.',
		].join('\r\n'),
	})
}

async function waitAll(promises: Array<Promise<unknown>>) {
	for (const promise of promises) await promise
}

async function addSenderRules(
	userId: string,
	rules: Array<
		[
			kind: 'address' | 'domain',
			value: string,
			effect: 'block' | 'quarantine' | 'allow',
		]
	>,
) {
	for (const [kind, value, effect] of rules) {
		await upsertEmailSenderRule({
			db: env.APP_DB,
			userId,
			kind,
			value,
			effect,
		})
	}
}

test('user sender rules block before quota, quarantine/allow, and fall back to auth verdicts', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const { userId, address } = await seedVerifiedAccount('spam')

	await addSenderRules(userId, [
		['address', 'blocked@spam.example', 'block'],
		['domain', 'suspect.example', 'quarantine'],
		['address', 'friend@example.net', 'allow'],
	])

	const blocked = mail('blocked@spam.example', address, 'Blocked mail')
	await handleInboundEmail(blocked, createInboundEnv())
	expect(blocked.rejectedReason).toBe('Message rejected by recipient policy.')
	expect(
		await mailboxRpc({ env, userId: ownerIdFromStored(userId) }).listMessages({
			limit: 10,
		}),
	).toMatchObject({ messages: [] })
	expect(await readUserDailyReceiveCount(userId)).toBe(0)
	const rejectEvents = await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).listDeliveryEvents({
		limit: 10,
	})
	const rejectDetails = rejectEvents.map((event) => ({
		eventType: event.eventType,
		detail: JSON.parse(event.detailJson) as Record<string, unknown>,
	}))
	expect(rejectDetails.every((row) => row.eventType === 'rejected')).toBe(true)
	expect(
		rejectDetails.find((row) => row.detail['aggregate'] !== true)?.detail,
	).toMatchObject({
		reason: 'Message rejected by recipient policy.',
		phase: 'sender-policy',
	})

	const quarantined = mail('news@suspect.example', address, 'Quarantine me')
	await handleInboundEmail(quarantined, createInboundEnv())
	expect(quarantined.rejectedReason).toBeNull()

	const spoofedAllow = mail(
		'friend@example.net',
		address,
		'Allow overrides failed auth',
		[`Authentication-Results: ${dmarcFailAuthResults()}`],
	)
	await handleInboundEmail(spoofedAllow, createInboundEnv())
	expect(spoofedAllow.rejectedReason).toBeNull()

	const allowedAuthenticated = mail(
		'friend@example.net',
		address,
		'Allowed when authenticated',
		[
			'Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
		],
	)
	await handleInboundEmail(allowedAuthenticated, createInboundEnv())
	expect(allowedAuthenticated.rejectedReason).toBeNull()

	const suspect = mail('stranger@example.net', address, 'Suspect auth', [
		`Authentication-Results: ${dmarcFailAuthResults()}`,
	])
	await handleInboundEmail(suspect, createInboundEnv())

	const clean = mail('stranger@example.net', address, 'No auth header')
	await handleInboundEmail(clean, createInboundEnv())

	const { messages } = await mailboxRpc({
		env,
		userId: ownerIdFromStored(userId),
	}).listMessages({
		limit: 20,
	})
	const bySubject = Object.fromEntries(
		messages.map((row) => [row.subject, row]),
	)
	expect(bySubject['Quarantine me']).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule suspect.example.',
	})
	expect(bySubject['Allow overrides failed auth']).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
	expect(bySubject['Allowed when authenticated']).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
	expect(bySubject['Suspect auth']).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Failed sender authentication.',
	})
	expect(bySubject['No auth header']).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
}, 30_000)

test('user quarantined and accepted messages dispatch matching subscription topics', async () => {
	silenceIncidentalRuntimeWarnings()
	packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents.mockClear()
	packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents.mockClear()
	await ensureEmailTestSchema(env.APP_DB)
	const { userId, address } = await seedVerifiedAccount('dispatch')
	await addSenderRules(userId, [['address', 'hold@example.net', 'quarantine']])

	const { ctx, waitUntilPromises } = createWaitUntilContext()
	const quarantined = mail('hold@example.net', address, 'Quarantined dispatch')
	await handleInboundEmail(quarantined, createInboundEnv(), ctx)
	expect(quarantined.rejectedReason).toBeNull()

	const accepted = mail('ok@example.net', address, 'Accepted dispatch')
	await handleInboundEmail(accepted, createInboundEnv(), ctx)
	expect(accepted.rejectedReason).toBeNull()

	await waitAll(waitUntilPromises)

	expect(
		packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents,
	).toHaveBeenCalledTimes(2)
	const dispatched =
		packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents.mock.calls.map(
			(call) => call[0]?.message,
		)
	expect(
		dispatched.find((message) => message?.subject === 'Quarantined dispatch'),
	).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule hold@example.net.',
	})
	expect(
		dispatched.find((message) => message?.subject === 'Accepted dispatch'),
	).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
	expect(
		packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()
})

test('system sender rules reject/block and suppress quarantined subscription dispatch', async () => {
	silenceIncidentalRuntimeWarnings()
	packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents.mockClear()
	packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents.mockClear()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	await addSenderRules(systemEmailOwnerId, [
		['address', 'blocked@spam.example', 'block'],
		['domain', 'suspect.example', 'quarantine'],
	])

	const blocked = mail(
		'blocked@spam.example',
		`kody@${systemDomain}`,
		'System blocked',
	)
	await handleInboundEmail(blocked, createInboundEnv())
	expect(blocked.rejectedReason).toBe('Message rejected by recipient policy.')
	expect(
		await listSystemEmailMessages({
			db: env.APP_DB,
			limit: 10,
		}),
	).toEqual([])

	const { ctx, waitUntilPromises } = createWaitUntilContext()
	const quarantined = mail(
		'bot@suspect.example',
		`postmaster@${systemDomain}`,
		'System quarantine',
	)
	await handleInboundEmail(quarantined, createInboundEnv(), ctx)
	expect(quarantined.rejectedReason).toBeNull()
	await waitAll(waitUntilPromises)

	const [stored] = await listSystemEmailMessages({
		db: env.APP_DB,
		limit: 1,
	})
	expect(stored).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule suspect.example.',
	})
	expect(
		packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()
	expect(
		packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()

	const effect = await env.APP_DB.prepare(
		`SELECT
			json_extract(detail_json, '$.subscriptionEffectState') AS subscription_state,
			json_extract(detail_json, '$.subscriptionEffectSuppressedQuarantineAt') AS suppressed_at
		FROM system_email_delivery_events
		WHERE event_type = 'received'
		ORDER BY created_at DESC
		LIMIT 1`,
	).first<{ subscription_state: string; suppressed_at: string }>()
	expect(effect?.subscription_state).toBe('complete')
	expect(effect?.suppressed_at).toEqual(expect.any(String))

	const delivery = await env.APP_DB.prepare(
		`SELECT id FROM system_email_delivery_events
		WHERE event_type = 'received'
		ORDER BY created_at DESC
		LIMIT 1`,
	).first<{ id: string }>()
	if (!delivery) throw new Error('Expected received system delivery.')
	await processInboundDeliveryEffects({
		env: createInboundEnv(),
		userId: systemEmailOwnerId,
		deliveryId: delivery.id,
	})
	expect(
		packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()
})
