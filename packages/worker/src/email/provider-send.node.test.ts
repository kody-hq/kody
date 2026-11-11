import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	CloudflareEmailProviderSkippedError,
	sendViaCloudflareEmailProvider,
} from './provider-send.ts'

const mockAccountId = 'cf_account_mock_123'
const apiUrl = `https://api.cloudflare.test/client/v4/accounts/${mockAccountId}/email/sending/send`

test('sendViaCloudflareEmailProvider prefers the EMAIL binding and skips REST', async () => {
	using _server = createMswNodeServer(
		[
			http.post(apiUrl, () => {
				throw new Error('REST fallback should not be called')
			}),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	const send = vi.fn(async () => ({ messageId: 'binding-1' }))
	const result = await sendViaCloudflareEmailProvider({
		env: {
			EMAIL: { send } as unknown as SendEmail,
			CLOUDFLARE_ACCOUNT_ID: mockAccountId,
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		from: 'owner@inbox.example.com',
		to: ['pager@example.com'],
		subject: 'Verify',
		html: '<p>Verify</p>',
		text: 'Verify',
	})
	expect(result).toEqual({ messageId: 'binding-1', via: 'binding' })
	expect(send).toHaveBeenCalledOnce()
	expect(send).toHaveBeenCalledWith(
		expect.objectContaining({
			from: 'owner@inbox.example.com',
			to: 'pager@example.com',
			subject: 'Verify',
		}),
	)
})

test('sendViaCloudflareEmailProvider falls back to REST when the binding throws', async () => {
	consoleWarn.mockImplementation(() => {})
	using _server = createMswNodeServer(
		[
			http.post(apiUrl, () =>
				HttpResponse.json({
					success: true,
					result: { message_id: 'rest-after-binding-fail' },
				}),
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	const send = vi.fn(async () => {
		throw new Error('binding unavailable')
	})
	const result = await sendViaCloudflareEmailProvider({
		env: {
			EMAIL: { send } as unknown as SendEmail,
			CLOUDFLARE_ACCOUNT_ID: mockAccountId,
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		from: 'owner@inbox.example.com',
		to: ['pager@example.com'],
		subject: 'Verify',
		html: '<p>Verify</p>',
		text: 'Verify',
	})
	expect(result).toEqual({
		messageId: 'rest-after-binding-fail',
		via: 'rest',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-binding-failed-falling-back-to-rest',
		expect.any(Error),
	)
})

test('sendViaCloudflareEmailProvider falls back to REST and rejects permanent bounces', async () => {
	consoleWarn.mockImplementation(() => {})
	using _server = createMswNodeServer(
		[
			http.post(apiUrl, async ({ request }) => {
				const body = (await request.json()) as { from: string; to: string }
				expect(body).toMatchObject({
					from: 'owner@inbox.example.com',
					to: 'pager@example.com',
				})
				return HttpResponse.json({
					success: true,
					result: {
						message_id: 'rest-bounce',
						delivered: [],
						queued: [],
						permanent_bounces: ['pager@example.com'],
					},
				})
			}),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	await expect(
		sendViaCloudflareEmailProvider({
			env: {
				CLOUDFLARE_ACCOUNT_ID: mockAccountId,
				CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
				CLOUDFLARE_API_TOKEN: 'token',
			},
			from: 'owner@inbox.example.com',
			to: ['pager@example.com'],
			subject: 'Verify',
			html: '<p>Verify</p>',
			text: 'Verify',
		}),
	).rejects.toThrow(/permanently bounced/)
})

test('sendViaCloudflareEmailProvider surfaces a skipped credential error', async () => {
	await expect(
		sendViaCloudflareEmailProvider({
			env: {},
			from: 'owner@inbox.example.com',
			to: ['pager@example.com'],
			subject: 'Verify',
			html: '<p>Verify</p>',
			text: 'Verify',
		}),
	).rejects.toBeInstanceOf(CloudflareEmailProviderSkippedError)
})

test('sendViaCloudflareEmailProvider sends Cc on the REST fallback and only fails when every recipient bounced', async () => {
	consoleWarn.mockImplementation(() => {})
	const bodies: Array<Record<string, unknown>> = []
	using _server = createMswNodeServer(
		[
			http.post(apiUrl, async ({ request }) => {
				bodies.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: {
						message_id: 'rest-cc',
						delivered: ['carol@example.com'],
						permanent_bounces: ['dan@example.com'],
					},
				})
			}),
		],
		{ onUnhandledFrame: 'bypass' },
	)
	const result = await sendViaCloudflareEmailProvider({
		env: {
			CLOUDFLARE_ACCOUNT_ID: mockAccountId,
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		from: 'owner@inbox.example.com',
		to: ['dan@example.com'],
		cc: ['carol@example.com'],
		subject: 'Re: Kickoff',
		text: 'Thanks',
	})
	expect(result).toEqual({ messageId: 'rest-cc', via: 'rest' })
	expect(bodies[0]).toMatchObject({
		to: 'dan@example.com',
		cc: ['carol@example.com'],
	})
	expect(bodies[0]).not.toHaveProperty('bcc')
})
