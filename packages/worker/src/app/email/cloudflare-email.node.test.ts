import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import { sendCloudflareEmail } from './cloudflare-email.ts'

const mockAccountId = 'cf_account_mock_123'
const testApiConfig = {
	accountId: mockAccountId,
	apiBaseUrl: 'https://api.cloudflare.test',
	apiToken: 'test-token',
}

type EmailMessage = Parameters<typeof sendCloudflareEmail>[1]

function message(
	subject: string,
	overrides: Partial<EmailMessage> = {},
): EmailMessage {
	return {
		to: 'recipient@example.com',
		from: 'reset@kody.dev',
		subject,
		html: '<p>body</p>',
		text: undefined,
		...overrides,
	}
}

test('sendCloudflareEmail delivers through the mock API and handles configuration and transport failures', async () => {
	const token = 'cloudflare-email-mock-token'
	await using mock = await startCloudflareMock(token)
	expect(
		(
			await fetch(`${mock.origin}/__mocks/clear?token=${token}`, {
				method: 'POST',
			})
		).status,
	).toBe(200)

	const sendResult = await sendCloudflareEmail(
		{
			accountId: mockAccountId,
			apiBaseUrl: mock.origin,
			apiToken: mock.token,
		},
		message('Reset your kody password', {
			html: '<p>Reset link</p>',
			text: 'Reset link',
		}),
	)
	expect(sendResult).toMatchObject({
		ok: true,
		messageId: expect.stringMatching(/^email_/),
	})

	const response = await fetch(`${mock.origin}/__mocks/messages?token=${token}`)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		count: number
		messages: Array<{
			from_email: string
			subject: string
			text: string | null
		}>
	}
	expect(payload.count).toBe(1)
	expect(payload.messages[0]).toMatchObject({
		from_email: 'reset@kody.dev',
		subject: 'Reset your kody password',
		text: 'Reset link',
	})

	const previewAccountId = 'a99ee2e72728dd52902ef288b7b1447d'
	const previewSend = await sendCloudflareEmail(
		{
			accountId: previewAccountId,
			apiBaseUrl: mock.origin,
			apiToken: mock.token,
		},
		message('Verify your email to finish setting up Kody', {
			from: 'kody@kody-pr-1.kody-a99.workers.dev',
			html: '<p>Verify</p>',
			text: 'Verify',
		}),
	)
	expect(previewSend.ok).toBe(true)

	const defaultBaseUrlRequests: Array<{ url: string }> = []
	using _defaultBaseUrlServer = createMswNodeServer(
		[
			http.post(
				`https://api.cloudflare.com/client/v4/accounts/${mockAccountId}/email/sending/send`,
				async ({ request }) => {
					defaultBaseUrlRequests.push(request.clone())
					return HttpResponse.json({
						success: true,
						result: {
							delivered: ['recipient@example.com'],
							permanent_bounces: [],
							queued: [],
						},
					})
				},
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	expect(
		await sendCloudflareEmail(
			{ accountId: mockAccountId, apiToken: 'test-token' },
			message('Default base URL', { text: 'body' }),
		),
	).toMatchObject({ ok: true })
	expect(defaultBaseUrlRequests.map((request) => request.url)).toEqual([
		`https://api.cloudflare.com/client/v4/accounts/${mockAccountId}/email/sending/send`,
	])

	expect(
		await sendCloudflareEmail(
			{},
			message('Skipped email', {
				html: '<p>secret body</p>',
				text: 'secret text',
			}),
		),
	).toEqual({ ok: false, skipped: true })
	expect(consoleInfo).toHaveBeenCalledTimes(1)
	const [skipReason, skipPayload] = consoleInfo.mock.calls[0]!
	expect(skipReason).toBe('cloudflare-email-unconfigured')
	expect(String(skipPayload)).not.toContain('secret body')
	expect(String(skipPayload)).not.toContain('secret text')
	expect(String(skipPayload)).not.toContain('recipient@example.com')
	expect(String(skipPayload)).toContain('***@example.com')
	expect(String(skipPayload)).toContain('Skipped email')

	// The transport failure below warns for operators; capture it instead of
	// letting the console guard fail the test.
	consoleWarn.mockImplementation(() => {})
	using _networkFailureServer = createMswNodeServer(
		[http.post('https://api.cloudflare.test/*', () => HttpResponse.error())],
		{ onUnhandledFrame: 'bypass' },
	)
	expect(
		await sendCloudflareEmail(testApiConfig, message('Request failure')),
	).toEqual({ ok: false, error: 'fetch failed' })
	// Exactly the one expected warning; anything else the mock swallowed
	// would be a regression hidden by the opt-in above.
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-request-failed',
		expect.any(Error),
	)

	using _invalidJsonServer = createMswNodeServer(
		[
			http.post('https://api.cloudflare.test/*', () =>
				HttpResponse.text('not-json', {
					headers: { 'content-type': 'application/json' },
				}),
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	await expect(
		sendCloudflareEmail(testApiConfig, message('Invalid JSON')),
	).rejects.toThrow('not valid JSON')
	// The parse failure throws before any operator warning, so the silenced
	// consoleWarn must not have picked up anything new.
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleInfo).toHaveBeenCalledTimes(1)
}, 75_000)

test('sendCloudflareEmail treats permanent_bounces as failure even when success is true', async () => {
	using _server = createMswNodeServer(
		[
			http.post(
				`https://api.cloudflare.test/client/v4/accounts/${mockAccountId}/email/sending/send`,
				() =>
					HttpResponse.json({
						success: true,
						result: {
							message_id: 'bounce-1',
							delivered: [],
							queued: [],
							permanent_bounces: ['recipient@example.com'],
						},
					}),
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	consoleWarn.mockImplementation(() => {})
	expect(
		await sendCloudflareEmail(testApiConfig, message('Bounced destination')),
	).toEqual({
		ok: false,
		messageId: 'bounce-1',
		error:
			'Cloudflare Email API permanently bounced every recipient (recipient@example.com).',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-permanent-bounce',
		expect.stringContaining('permanent_bounces'),
	)
	expect(String(consoleWarn.mock.calls[0]?.[1])).not.toContain(
		'recipient@example.com',
	)
})

test('sendCloudflareEmail keeps success when only some recipients permanently bounce', async () => {
	using _server = createMswNodeServer(
		[
			http.post(
				`https://api.cloudflare.test/client/v4/accounts/${mockAccountId}/email/sending/send`,
				() =>
					HttpResponse.json({
						success: true,
						result: {
							message_id: 'partial-1',
							delivered: ['alice@example.com'],
							queued: [],
							permanent_bounces: ['bob@example.com'],
						},
					}),
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	expect(
		await sendCloudflareEmail(testApiConfig, {
			to: ['alice@example.com', 'bob@example.com'],
			from: 'owner@inbox.example.com',
			subject: 'Partial bounce',
			html: '<p>body</p>',
			text: 'body',
		}),
	).toEqual({ ok: true, messageId: 'partial-1' })
})

test('sendCloudflareEmail defaults Reply-To to support@ when From is kody@ unless overridden', async () => {
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswNodeServer(
		[
			http.post(
				`https://api.cloudflare.test/client/v4/accounts/${mockAccountId}/email/sending/send`,
				async ({ request }) => {
					payloads.push((await request.json()) as Record<string, unknown>)
					return HttpResponse.json({
						success: true,
						result: { message_id: 'reply-to-1' },
					})
				},
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	const sends = [
		['kody@kody.codes', 'Verify your email', undefined],
		['kody@kody.codes', 'Operator override', 'abuse@kody.codes'],
		['support@kody.codes', 'Support sender', undefined],
		['alice@inbox.kody.codes', 'User mail', undefined],
	] as const
	for (const [from, subject, replyTo] of sends) {
		await sendCloudflareEmail(testApiConfig, {
			to: 'user@example.com',
			from,
			subject,
			html: `<p>${subject}</p>`,
			text: subject,
			...(replyTo ? { replyTo } : {}),
		})
	}

	expect(
		payloads.map((payload) => [
			payload.from,
			payload.reply_to,
			Object.hasOwn(payload, 'reply_to'),
			Object.hasOwn(payload, 'replyTo'),
		]),
	).toEqual([
		['kody@kody.codes', 'support@kody.codes', true, false],
		['kody@kody.codes', 'abuse@kody.codes', true, false],
		['support@kody.codes', undefined, false, false],
		['alice@inbox.kody.codes', undefined, false, false],
	])
})

test('sendCloudflareEmail retries one retryable transport failure', async () => {
	consoleWarn.mockImplementation(() => {})
	const lost = () =>
		Object.assign(new Error('Network connection lost.'), { retryable: true })
	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValueOnce(lost())
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				errors: [],
				result: { delivered: ['user@example.com'], permanent_bounces: [] },
			}),
		)
		.mockRejectedValueOnce(lost())
		.mockRejectedValueOnce(lost())
	try {
		expect(
			await sendCloudflareEmail(testApiConfig, message('Retry once')),
		).toMatchObject({ ok: true })
		expect(fetchSpy).toHaveBeenCalledTimes(2)

		expect(
			await sendCloudflareEmail(testApiConfig, message('Retry exhausted')),
		).toEqual({ ok: false, error: 'Network connection lost.' })
		expect(fetchSpy).toHaveBeenCalledTimes(4)
	} finally {
		fetchSpy.mockRestore()
	}
})
