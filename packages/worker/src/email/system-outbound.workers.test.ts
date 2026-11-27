import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { isMcpCallerError } from '#mcp/caller-error.ts'
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

const {
	sendSystemEmail,
	sendNewsletterEmail,
	sendNewsletterConfirmationEmail,
} = await import('./system-outbound.ts')

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

test('newsletter confirmation mail uses the news sender with its own send kind', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-15T05:06:07.000Z')
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				payloads.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'newsletter-confirm-1' },
				})
			}),
		],
		mswOptions,
	)
	const input = {
		env: createSystemEnv(),
		to: 'confirm-reader@example.com',
		subject: 'Confirm',
		html: '<p>Confirm</p>',
		text: 'Confirm',
		now,
	}
	await sendNewsletterConfirmationEmail(input)
	expect(payloads[0]).toMatchObject({
		from: { address: 'news@kody.example.com' },
		to: 'confirm-reader@example.com',
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT kind, sender FROM system_email_sends WHERE provider_message_id = ?`,
		)
			.bind('newsletter-confirm-1')
			.first(),
	).toMatchObject({
		kind: 'whats_new_confirm',
		sender: 'news@kody.example.com',
	})
	await expect(
		sendNewsletterConfirmationEmail({ ...input, to: 'not an address' }),
	).rejects.toThrow('recipient')
})

test('newsletter mail has a dedicated sender, quota, send kind, and one-recipient contract', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-14T05:06:07.000Z')
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				payloads.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'newsletter-1' },
				})
			}),
		],
		mswOptions,
	)
	const input = {
		env: createSystemEnv(),
		to: 'reader@example.com',
		subject: 'Updates',
		html: '<p>News</p>',
		text: 'News',
		headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
		now,
	}
	const before = await readSendCounter('kody', now)
	await sendNewsletterEmail(input)
	expect(payloads[0]).toMatchObject({
		from: { address: 'news@kody.example.com', name: 'Kent from Kody' },
		to: 'reader@example.com',
		reply_to: 'kent@kody.example.com',
		html: input.html,
		text: input.text,
		headers: input.headers,
	})
	expect(await readSendCounter('news', now)).toBe(1)
	expect(await readSendCounter('kody', now)).toBe(before)
	expect(
		await env.APP_DB.prepare(
			`SELECT kind, sender FROM system_email_sends WHERE provider_message_id = 'newsletter-1'`,
		).first(),
	).toMatchObject({ kind: 'whats_new', sender: 'news@kody.example.com' })
	for (const to of ['', ['reader@example.com']]) {
		await expect(
			sendNewsletterEmail({ ...input, to: to as string }),
		).rejects.toThrow('One newsletter recipient')
	}
	await expect(
		sendNewsletterEmail({ ...input, text: '', html: '' }),
	).rejects.toThrow('Email text or HTML')
	await expect(
		sendSystemEmail({ ...input, localPart: 'news' }),
	).rejects.toThrow('not available for transactional')
	await env.APP_DB.prepare(
		`UPDATE system_email_daily_counters SET count = ? WHERE local_part = 'send:news' AND day = ?`,
	)
		.bind(systemEmailLimits.maxNewsletterSendsPerDay, systemEmailDayKey(now))
		.run()
	await expect(sendNewsletterEmail(input)).rejects.toThrow(
		'newsletter send limit (2000)',
	)
	expect(payloads).toHaveLength(1)
})

test('newsletter transport loss surfaces without retry while transactional mail still retries', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-16T05:06:07.000Z')
	const lost = Object.assign(new Error('Network connection lost.'), {
		retryable: true,
	})
	const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(lost)
	const input = {
		env: createSystemEnv(),
		to: 'reader@example.com',
		subject: 'Updates',
		text: 'News',
		now,
	}
	try {
		await expect(sendNewsletterEmail(input)).rejects.toThrow(
			'Network connection lost.',
		)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(await readSendCounter('news', now)).toBe(0)
		fetchSpy.mockReset()
		fetchSpy.mockRejectedValueOnce(lost).mockResolvedValueOnce(
			Response.json({
				success: true,
				result: { message_id: 'transactional-retry' },
			}),
		)
		await expect(sendSystemEmail(input)).resolves.toMatchObject({
			providerMessageId: 'transactional-retry',
		})
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(await readSendCounter('kody', now)).toBe(1)
	} finally {
		fetchSpy.mockRestore()
	}
})

test('system send paths never extract a different recipient from unsupported address syntax', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				payloads.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'address-check' },
				})
			}),
		],
		mswOptions,
	)
	const input = {
		env: createSystemEnv(),
		to: "o'connor@example.com",
		subject: 'Updates',
		text: 'News',
	}
	await expect(sendNewsletterEmail(input)).rejects.toThrow('recipient')
	await expect(sendSystemEmail(input)).rejects.toThrow('recipient')
	expect(payloads).toEqual([])
})

test('newsletter mail respects suppression and refunds provider failures', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-15T05:06:07.000Z')
	await env.APP_DB.prepare(
		`INSERT INTO email_recipient_suppressions (recipient, hard_bounce_count, suppressed_at, last_status, last_hard_bounce_at, created_at, updated_at) VALUES ('newsletter-gone@example.com', 2, ?1, 'bounced', ?1, ?1, ?1)`,
	)
		.bind(now.toISOString())
		.run()
	const input = {
		env: createSystemEnv(),
		to: 'newsletter-gone@example.com',
		subject: 'Updates',
		text: 'News',
		now,
	}
	await expect(sendNewsletterEmail(input)).rejects.toThrow('Email was not sent')
	expect(await readSendCounter('news', now)).toBe(0)
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, () =>
				HttpResponse.json({
					success: false,
					errors: [{ message: 'Provider failed' }],
				}),
			),
		],
		mswOptions,
	)
	await expect(
		sendNewsletterEmail({ ...input, to: 'reader@example.com' }),
	).rejects.toThrow('Provider failed')
	expect(await readSendCounter('news', now)).toBe(0)
	expect(consoleWarn).toHaveBeenCalled()
})

test('a Cloudflare 400 invalid-content rejection is a caller error and refunds the newsletter quota', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-15T07:19:37.000Z')
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, () =>
				HttpResponse.json(
					{
						success: false,
						errors: [
							{ code: 10202, message: 'email.sending.error.email.invalid' },
						],
					},
					{ status: 400 },
				),
			),
		],
		mswOptions,
	)
	const error = await sendNewsletterEmail({
		env: createSystemEnv(),
		to: 'reader@example.com',
		subject: 'Updates',
		text: 'News',
		headers: {
			'List-Unsubscribe': '<https://news.example.com/unsubscribe?t=1>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		},
		now,
	}).catch((caught: unknown) => caught)
	expect(isMcpCallerError(error)).toBe(true)
	expect((error as Error).message).toContain(
		'HTTP 400, code 10202: email.sending.error.email.invalid',
	)
	expect((error as Error).message).toContain('custom header')
	expect(await readSendCounter('news', now)).toBe(0)
})

test('Cloudflare auth, throttling, and outage responses stay server failures', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-15T07:20:00.000Z')
	for (const [status, code, message] of [
		[401, 10101, 'email.sending.error.authentication.unauthorized'],
		[403, 10203, 'email.sending.error.email.sending_disabled'],
		[429, 10004, 'email.sending.error.throttled'],
		[500, 10002, 'email.sending.error.internal_server'],
	] as const) {
		using _server = createMswWorkerServer(
			[
				http.post(cloudflareEmailApi, () =>
					HttpResponse.json(
						{ success: false, errors: [{ code, message }] },
						{ status },
					),
				),
			],
			mswOptions,
		)
		const error = await send({ localPart: 'support', now }).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toBe(message)
		expect(isMcpCallerError(error)).toBe(false)
	}
	expect(await readSendCounter('support', now)).toBe(0)
})

test('custom headers Cloudflare refuses are caller errors before the provider or quota is touched', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-15T07:21:00.000Z')
	const providerCalls: Array<unknown> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				providerCalls.push(await request.json())
				return HttpResponse.json({
					success: true,
					result: { message_id: 'msg-headers', delivered: [] },
				})
			}),
		],
		mswOptions,
	)
	for (const [headers, expected] of [
		[{ 'Reply-To': 'kent@kody.example.com' }, 'dedicated reply-to field'],
		[{ 'message-id': '<a@elsewhere.example>' }, 'Cloudflare generates it'],
		[{ Subject: 'Other' }, 'dedicated subject field'],
		[{ 'ARC-Seal': 'i=1' }, 'Cloudflare generates it'],
		[{ 'Bad Header': 'x' }, 'Header name "Bad Header" is invalid'],
		[{ 'X-Campaign': ' ' }, 'empty value'],
		[{ 'X-Campaign': 'a\r\nBcc: x@example.com' }, 'line breaks'],
	] as const) {
		const error = await sendNewsletterEmail({
			env: createSystemEnv(),
			to: 'reader@example.com',
			subject: 'Updates',
			text: 'News',
			headers,
			now,
		}).catch((caught: unknown) => caught)
		expect(isMcpCallerError(error)).toBe(true)
		expect((error as Error).message).toContain(expected)
	}
	expect(providerCalls).toEqual([])
	expect(await readSendCounter('news', now)).toBe(0)

	await sendNewsletterEmail({
		env: createSystemEnv(),
		to: 'reader@example.com',
		subject: 'Updates',
		text: 'News',
		headers: {
			'List-Unsubscribe': '<https://news.example.com/unsubscribe?t=1>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			'X-Campaign_Id': 'whats-new',
		},
		now,
	})
	expect(providerCalls).toHaveLength(1)
	expect(providerCalls[0]).toMatchObject({
		reply_to: 'kent@kody.example.com',
		headers: { 'X-Campaign_Id': 'whats-new' },
	})
})

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

test('a newsletter idempotency key replays a finished send and never sends twice', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-27T18:00:00.000Z')
	let status = 200
	const payloads: Array<unknown> = []
	using _server = createMswWorkerServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				payloads.push(await request.json())
				return status === 200
					? HttpResponse.json({
							success: true,
							result: { message_id: `keyed-${payloads.length}` },
						})
					: HttpResponse.json(
							{
								success: false,
								errors: [
									{ code: 10202, message: 'email.sending.error.email.invalid' },
								],
							},
							{ status },
						)
			}),
		],
		mswOptions,
	)
	const input = {
		env: createSystemEnv(),
		to: 'reader@example.com',
		subject: 'Updates',
		text: 'News',
		idempotencyKey: 'campaign-a:user-1',
		now,
	}
	expect(await sendNewsletterEmail(input)).toEqual({
		from: 'news@kody.example.com',
		to: ['reader@example.com'],
		providerMessageId: 'keyed-1',
	})
	expect(await sendNewsletterEmail(input)).toEqual({
		from: 'news@kody.example.com',
		to: ['reader@example.com'],
		providerMessageId: 'keyed-1',
		replayed: true,
	})
	expect(payloads).toHaveLength(1)
	expect(await readSendCounter('news', now)).toBe(1)
	await expect(
		sendNewsletterEmail({ ...input, to: 'other@example.com' }),
	).rejects.toThrow('different recipient')

	// A definite rejection never reached a mailbox, so the key may be retried.
	status = 400
	const rejectedKey = { ...input, idempotencyKey: 'campaign-a:user-2' }
	await expect(sendNewsletterEmail(rejectedKey)).rejects.toThrow(
		'email.sending.error.email.invalid',
	)
	status = 200
	expect(await sendNewsletterEmail(rejectedKey)).toMatchObject({
		providerMessageId: 'keyed-3',
	})
	expect(payloads).toHaveLength(3)

	// The daily limit refuses before Cloudflare, so the key may be retried.
	const cappedKey = { ...input, idempotencyKey: 'campaign-a:user-3' }
	await env.APP_DB.prepare(
		`UPDATE system_email_daily_counters SET count = ? WHERE local_part = 'send:news' AND day = ?`,
	)
		.bind(systemEmailLimits.maxNewsletterSendsPerDay, systemEmailDayKey(now))
		.run()
	await expect(sendNewsletterEmail(cappedKey)).rejects.toThrow(
		'newsletter send limit',
	)
	await env.APP_DB.prepare(
		`UPDATE system_email_daily_counters SET count = 0 WHERE local_part = 'send:news' AND day = ?`,
	)
		.bind(systemEmailDayKey(now))
		.run()
	expect(await sendNewsletterEmail(cappedKey)).toMatchObject({
		providerMessageId: 'keyed-4',
	})
	expect(payloads).toHaveLength(4)
})

test('a newsletter key whose attempt never finished is refused as outcome unknown', async () => {
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-11-27T18:05:00.000Z')
	const lost = Object.assign(new Error('Network connection lost.'), {
		retryable: true,
	})
	const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(lost)
	const input = {
		env: createSystemEnv(),
		to: 'reader@example.com',
		subject: 'Updates',
		text: 'News',
		idempotencyKey: 'campaign-b:user-1',
		now,
	}
	try {
		await expect(sendNewsletterEmail(input)).rejects.toThrow(
			'Network connection lost.',
		)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const unknown = await sendNewsletterEmail(input).catch(
			(caught: unknown) => caught,
		)
		expect(isMcpCallerError(unknown)).toBe(true)
		expect(String(unknown)).toContain('Outcome unknown')
		// A caller cut off mid-call leaves the key pending; retries are refused too.
		await env.APP_DB.prepare(
			`INSERT INTO system_email_send_keys (kind, idempotency_key, recipient, state, created_at, updated_at)
			VALUES ('whats_new', 'campaign-b:user-2', 'reader@example.com', 'pending', ?1, ?1)`,
		)
			.bind(now.toISOString())
			.run()
		await expect(
			sendNewsletterEmail({ ...input, idempotencyKey: 'campaign-b:user-2' }),
		).rejects.toThrow('Outcome unknown')
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	} finally {
		fetchSpy.mockRestore()
	}
})
