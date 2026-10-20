import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareEmail from '#app/email/cloudflare-email.ts'
import { type PlatformFeedbackRecord } from './types.ts'

const sendCloudflareEmail = vi.fn<typeof CloudflareEmail.sendCloudflareEmail>(
	async () => ({ ok: true }),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const {
	platformFeedbackOutcomeEmailKvKey,
	sendPlatformFeedbackOutcomeEmail,
	shouldSendPlatformFeedbackOutcomeEmail,
} = await import('./outcome-email.ts')

const outcomeEmailClaimTtlSeconds = 30 * 24 * 60 * 60

const feedback: PlatformFeedbackRecord = {
	id: 'feedback-1',
	submitterUserId: 'user-1',
	submitterUsername: 'user-1-name',
	submitterEmail: 'user-1@example.com',
	category: 'friction',
	summary: '</p><script>alert(1)</script>Setup is confusing',
	details: 'The setup flow does not explain the next action.',
	status: 'resolved',
	reviewedByUserId: 'admin-1',
	reviewedAt: '2026-07-19T01:00:00.000Z',
	adminNote: 'platform-feedback-triage shipped: do not mail this',
	resolutionNote: null,
	resolutionPrUrls: [],
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T01:00:00.000Z',
}

type SentEmail = {
	to: string
	from: string
	subject: string
	html: string
	text: string
}

function createKv(order?: Array<string>) {
	const store = new Map<string, string>()
	const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = []
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		async put(
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		) {
			order?.push('put')
			puts.push({ key, options })
			store.set(key, value)
		},
		delete: async (key: string) => void store.delete(key),
	} as unknown as KVNamespace
	return { kv, store, puts }
}

function createUserDb(
	row: {
		email?: string
		suspended_at?: string | null
		email_outbound_paused_at?: string | null
	} | null,
) {
	const first = async () =>
		row && {
			email: row.email ?? 'ada@example.com',
			suspended_at: row.suspended_at ?? null,
			email_outbound_paused_at: row.email_outbound_paused_at ?? null,
		}
	return {
		prepare: () => ({ bind: () => ({ first }) }),
	} as unknown as D1Database
}

function createEnv(input?: { kv?: KVNamespace; db?: D1Database }) {
	return {
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input?.kv,
		APP_DB: input?.db ?? createUserDb({}),
	} as unknown as Env
}

function send(
	env: Env,
	input: {
		id?: string
		status?: 'resolved' | 'dismissed'
		userMessage?: string
	} = {},
) {
	const { id = feedback.id, status = 'resolved', userMessage } = input
	return sendPlatformFeedbackOutcomeEmail({
		env,
		feedback: { ...feedback, id, status },
		status,
		...(userMessage ? { userMessage } : {}),
	})
}

function lastSentEmail() {
	return sendCloudflareEmail.mock.lastCall?.[1] as SentEmail
}

function claimKey(feedbackId: string) {
	return platformFeedbackOutcomeEmailKvKey({ feedbackId, status: 'resolved' })
}

test('platform feedback outcome emails send once per terminal status, escape summaries, and skip unsafe recipients', async () => {
	const shouldSendCases = [
		{ didChangeStatus: true, status: 'triaged' as const, expected: false },
		{ didChangeStatus: false, status: 'resolved' as const, expected: false },
		{ didChangeStatus: true, status: 'resolved' as const, expected: true },
	]
	expect(
		shouldSendCases.filter(
			({ expected, ...input }) =>
				shouldSendPlatformFeedbackOutcomeEmail(input) !== expected,
		),
	).toEqual([])

	expect(await send(createEnv())).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const { kv, store, puts } = createKv()
	const env = createEnv({ kv })
	expect(await send(env)).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const resolvedEmail = lastSentEmail()
	expect(resolvedEmail.to).toBe('ada@example.com')
	expect(resolvedEmail.from).toBe('kody@kody.codes')
	expect(resolvedEmail.subject).toContain('resolved')
	expect(resolvedEmail.html).not.toContain('<script>')
	expect(resolvedEmail.html).toContain(
		'&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;Setup is confusing',
	)
	expect(resolvedEmail.html).not.toContain(feedback.details)
	expect(resolvedEmail.html).not.toContain('platform-feedback-triage shipped')
	expect(resolvedEmail.text).toContain(
		'tell your agent you want to send more Kody feedback',
	)
	expect(store.get(claimKey('feedback-1'))).toBeTruthy()
	expect(puts[0]?.options?.expirationTtl).toBe(outcomeEmailClaimTtlSeconds)

	const userMessage = 'We shipped a clearer setup path.'
	sendCloudflareEmail.mockClear()
	expect(await send(env, { userMessage })).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	expect(
		await send(env, { id: 'feedback-2', status: 'dismissed', userMessage }),
	).toBe(true)
	const dismissedEmail = lastSentEmail()
	expect(dismissedEmail.subject).toContain('update')
	expect(dismissedEmail.html).toContain(userMessage)
	expect(dismissedEmail.text).toContain(userMessage)
	expect(dismissedEmail.html).toContain(
		'closed it without a product change this time',
	)

	const skippedRecipients = [
		{ id: 'feedback-no-user', row: null },
		{ id: 'feedback-no-email', row: { email: '' } },
		{
			id: 'feedback-paused',
			row: { email_outbound_paused_at: '2026-07-20T00:00:00.000Z' },
		},
		{
			id: 'feedback-suspended',
			row: { suspended_at: '2026-07-20T00:00:00.000Z' },
		},
	]
	for (const { id, row } of skippedRecipients) {
		expect(await send(createEnv({ kv, db: createUserDb(row) }), { id })).toBe(
			false,
		)
	}
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
})

test('platform feedback outcome emails reserve the KV claim before sending and release it on send failure', async () => {
	const order: Array<string> = []
	const { kv, store } = createKv(order)
	sendCloudflareEmail.mockImplementation(async () => {
		order.push('send')
		throw new Error('smtp down')
	})
	consoleWarn.mockImplementation(() => {})

	expect(await send(createEnv({ kv }), { id: 'feedback-claim' })).toBe(false)
	expect(order).toEqual(['put', 'send'])
	expect(consoleWarn).toHaveBeenCalledWith(
		'platform-feedback-outcome-email-send-failed',
		{
			feedbackId: 'feedback-claim',
			status: 'resolved',
			error: expect.any(Error),
		},
	)
	expect(store.get(claimKey('feedback-claim'))).toBeUndefined()
})
