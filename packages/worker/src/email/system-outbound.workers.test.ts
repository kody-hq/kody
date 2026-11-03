import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswWorkerServer } from '#worker/test-support/msw-worker-server.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { systemEmailDayKey, systemEmailLimits } from './system-email.ts'
import { systemEmailSentTopic } from './system-email-sent-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchSystemEmailSentSubscriptionEvent: vi.fn(async () => []),
}))

vi.mock('./system-email-sent-package-subscriptions.ts', () => ({
	dispatchSystemEmailSentSubscriptionEvent:
		mocks.dispatchSystemEmailSentSubscriptionEvent,
}))

const { sendSystemEmail } = await import('./system-outbound.ts')

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

const mswOptions = { onUnhandledFrame: 'bypass' as const }

function createSystemEnv() {
	return {
		...env,
		APP_BASE_URL: 'https://kody.example.com',
		SYSTEM_EMAIL_DOMAIN: 'kody.example.com',
		CLOUDFLARE_ACCOUNT_ID: 'account-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'token-123',
	}
}

async function readSendCounter(localPart: string, now = new Date()) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM system_email_daily_counters
		WHERE local_part = ? AND day = ?`,
	)
		.bind(`send:${localPart}`, systemEmailDayKey(now))
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

function send(overrides: Partial<Parameters<typeof sendSystemEmail>[0]> = {}) {
	return sendSystemEmail({
		env: createSystemEnv(),
		to: 'reporter@example.com',
		subject: 'Hi',
		text: 'Body',
		...overrides,
	})
}

test('sendSystemEmail sends from the reserved system sender to external recipients', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-03-04T05:06:07.000Z')
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				payloads.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'system-message-1' },
				})
			}),
		],
		mswOptions,
	)

	mocks.dispatchSystemEmailSentSubscriptionEvent.mockClear()
	const result = await send({
		to: ['Reporter@Example.com', 'reporter@example.com'],
		subject: '  Thanks for the report  ',
		text: 'We shipped the fix.',
		replyTo: 'support@kody.example.com',
		now,
	})

	expect(result).toEqual({
		from: 'kody@kody.example.com',
		to: ['reporter@example.com'],
		providerMessageId: 'system-message-1',
	})
	expect(mocks.dispatchSystemEmailSentSubscriptionEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			event: expect.objectContaining({
				event: systemEmailSentTopic,
				from: 'kody@kody.example.com',
				to: ['reporter@example.com'],
				subject: 'Thanks for the report',
				text: 'We shipped the fix.',
				reply_to: 'support@kody.example.com',
				provider_message_id: 'system-message-1',
				sent_at: now.toISOString(),
			}),
		}),
	)
	expect(payloads).toEqual([
		expect.objectContaining({
			from: 'kody@kody.example.com',
			to: 'reporter@example.com',
			subject: 'Thanks for the report',
			text: 'We shipped the fix.',
			html: '<!doctype html><html lang="en"><body><p>We shipped the fix.</p></body></html>',
			reply_to: 'support@kody.example.com',
		}),
	])
	expect(payloads[0]).not.toHaveProperty('replyTo')
	expect(await readSendCounter('kody', now)).toBe(1)

	// The kody sender defaults Reply-To to support; the support sender has none.
	const replyToDefaults = [
		{
			localPart: undefined,
			from: 'kody@kody.example.com',
			replyTo: 'support@kody.example.com',
		},
		{ localPart: 'support', from: 'support@kody.example.com', replyTo: null },
	] as const
	for (const { localPart, from, replyTo } of replyToDefaults) {
		mocks.dispatchSystemEmailSentSubscriptionEvent.mockClear()
		payloads.length = 0
		expect((await send({ localPart, now })).from).toBe(from)
		expect(mocks.dispatchSystemEmailSentSubscriptionEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({ from, reply_to: replyTo }),
			}),
		)
		expect(payloads).toHaveLength(1)
		expect(payloads[0]).toMatchObject({ from })
		expect(payloads[0]?.['reply_to']).toBe(replyTo ?? undefined)
		expect(payloads[0]).not.toHaveProperty('replyTo')
	}
})

test('sendSystemEmail rejects unusable senders, recipients, and bodies', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, () => {
				throw new Error('Send should not be attempted')
			}),
		],
		mswOptions,
	)

	const rejections: Array<
		[Partial<Parameters<typeof sendSystemEmail>[0]>, string]
	> = [
		[{ localPart: 'marketing' as 'kody' }, 'Unknown system sender "marketing"'],
		// Inbound-only alias: never a system sender.
		[{ localPart: 'team' as 'kody' }, 'Unknown system sender "team"'],
		[
			{ to: 'not-an-address' },
			'Invalid recipient email address: not-an-address',
		],
		[
			{ to: Array.from({ length: 6 }, (_, index) => `r${index}@example.com`) },
			'at most 5 recipients',
		],
		[{ subject: '   ' }, 'Email subject is required.'],
		[{ text: undefined }, 'Email text or HTML body is required.'],
		[
			{
				env: {
					...createSystemEnv(),
					APP_BASE_URL: '',
					SYSTEM_EMAIL_DOMAIN: '',
				},
			},
			'no system email domain is configured',
		],
	]
	for (const [overrides, message] of rejections) {
		await expect(send(overrides)).rejects.toThrow(message)
	}
})

test('a failed provider call refunds the daily send budget and the cap blocks further sends', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	// The provider client warns on an API error response; that is the
	// behavior under test here.
	consoleWarn.mockImplementation(() => {})
	const now = new Date('2026-03-05T05:06:07.000Z')
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, () =>
				HttpResponse.json(
					{ success: false, errors: [{ message: 'Recipient rejected' }] },
					{ status: 400 },
				),
			),
		],
		mswOptions,
	)

	await expect(send({ localPart: 'support', now })).rejects.toThrow(
		'Recipient rejected',
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.stringContaining('Recipient rejected'),
	)
	expect(await readSendCounter('support', now)).toBe(0)

	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(local_part, day) DO UPDATE SET count = excluded.count`,
	)
		.bind(
			'send:support',
			systemEmailDayKey(now),
			systemEmailLimits.maxSendsPerDay,
			now.toISOString(),
		)
		.run()

	await expect(send({ localPart: 'support', now })).rejects.toThrow(
		'Daily system email send limit reached',
	)
	// Receives keep their own budget: the send cap never blocks inbound mail.
	expect(
		await env.APP_DB.prepare(
			`SELECT count FROM system_email_daily_counters
			WHERE local_part = 'support' AND day = ?`,
		)
			.bind(systemEmailDayKey(now))
			.first(),
	).toBeNull()
})

test('sendSystemEmail records each recipient for delivery reports and refuses suppressed recipients', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-03-06T05:06:07.000Z')
	let sends = 0
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, () => {
				sends += 1
				return HttpResponse.json({
					success: true,
					result: { message_id: 'system-message-recorded' },
				})
			}),
		],
		mswOptions,
	)

	await send({ to: ['first@example.com', 'Second@Example.com'], now })
	const { results } = await env.APP_DB.prepare(
		`SELECT recipient, sender, kind FROM system_email_sends
		WHERE provider_message_id = 'system-message-recorded'
		ORDER BY recipient`,
	).all()
	expect(results).toEqual([
		{
			recipient: 'first@example.com',
			sender: 'kody@kody.example.com',
			kind: 'operator',
		},
		{
			recipient: 'second@example.com',
			sender: 'kody@kody.example.com',
			kind: 'operator',
		},
	])

	await env.APP_DB.prepare(
		`INSERT INTO email_recipient_suppressions (
			recipient, hard_bounce_count, suppressed_at, verification_suppressed_at,
			last_status, last_detail, last_hard_bounce_at, created_at, updated_at
		) VALUES ('gone@example.com', 2, ?1, NULL, 'bounced', NULL, ?1, ?1, ?1)
		ON CONFLICT(recipient) DO NOTHING`,
	)
		.bind(now.toISOString())
		.run()
	const before = await readSendCounter('kody', now)
	await expect(
		send({ to: ['ok@example.com', 'gone@example.com'], now }),
	).rejects.toThrow('gone@example.com: Email was not sent')
	expect(sends).toBe(1)
	expect(await readSendCounter('kody', now)).toBe(before)
})
