import { expect, test, vi } from 'vitest'
import type * as CloudflareEmail from '#app/email/cloudflare-email.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'

const mockModule = vi.hoisted(() => ({
	createRecord: vi.fn(async () => undefined),
	deleteMany: vi.fn(async () => undefined),
	update: vi.fn(async () => undefined),
	findOne: vi.fn(
		async (_table: unknown, query?: { where?: Record<string, unknown> }) => {
			if (query?.where && 'token_hash' in query.where) {
				return {
					id: 1,
					user_id: 123,
					token_hash: query.where.token_hash,
					expires_at: Date.now() + 60_000,
				}
			}
			return {
				id: 123,
				email: 'user@example.com',
				stable_user_id: 'a'.repeat(64),
			}
		},
	),
	sendCloudflareEmail: vi.fn(
		async (
			..._args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>
		) => ({ ok: true }),
	),
}))

vi.mock('#worker/db.ts', () => ({
	createDb: () => ({
		create: mockModule.createRecord,
		deleteMany: mockModule.deleteMany,
		findOne: mockModule.findOne,
		update: mockModule.update,
	}),
	passwordResetsTable: {},
	usersTable: {},
}))

// The shared audit-log-spy setup file routes logAuditEvent; this test also
// needs getRequestIp pinned to null for deterministic audit payloads.
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => null,
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>
	) => mockModule.sendCloudflareEmail(...args),
}))

const { requestWebsitePasswordReset, confirmWebsitePasswordReset } =
	await import('#worker/identity/password-reset-operations.ts')
const { runWithDeferredWork } = await import('#worker/deferred-work.ts')

function createEnv(
	overrides: Record<string, unknown> = {},
	options: { hardBounce?: boolean; queries?: Array<string> } = {},
) {
	return {
		APP_DB: {
			prepare: (query: string) => ({
				bind: (...args: Array<unknown>) => ({
					// Only token writes succeed; 2FA/passkey/provider deletes report 0 rows.
					run: async () => {
						options.queries?.push(query)
						const hit = /^(delete from|insert into) password_resets/i.test(
							query.replace(/\s+/g, ' ').trim(),
						)
						return { meta: { changes: hit ? 1 : 0, last_row_id: hit ? 1 : 0 } }
					},
					first: async () => {
						options.queries?.push(query)
						if (
							options.hardBounce &&
							query.includes('email_verification_hard_bounces')
						) {
							return { recipient: args[0], status: 'bounced' }
						}
						return null
					},
				}),
			}),
			exec: async () => undefined,
		},
		CLOUDFLARE_ACCOUNT_ID: 'account-id',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'api-token',
		// Form protection may omit Turnstile only on known non-production runtimes.
		// Prefer test over WRANGLER_IS_LOCAL_DEV so request-origin email links stay
		// gated the same way as before.
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Env
}

// The request handler defers token creation and the email send past the
// response so latency cannot reveal whether the address is registered; tests
// collect the deferred work the way `ctx.waitUntil` does in the worker.
async function requestReset(
	env: Record<string, unknown>,
	url: string,
	body: Record<string, unknown> = { email: 'user@example.com' },
	options: { hardBounce?: boolean; queries?: Array<string> } = {},
) {
	const bindings = createEnv(env, options)
	const deferred = new Array<Promise<unknown>>()
	const response = await runWithDeferredWork(
		(promise) => deferred.push(promise),
		() =>
			requestWebsitePasswordReset({
				env: bindings,
				request: new Request(url),
				url: new URL(url),
				body,
			}),
	)
	return { response, flush: () => Promise.all(deferred) }
}

function sentMessage() {
	return mockModule.sendCloudflareEmail.mock.calls[0]![1] as {
		from: string
		to: string
		text: string
		html: string
	}
}

const hexTokenPattern = /[0-9a-f]{64}/i
const kodyCodes = {
	APP_BASE_URL: 'https://kody.codes',
	SYSTEM_EMAIL_DOMAIN: 'kody.codes',
}

test('password reset request ignores leftover website autofill and rejects the honeypot', async () => {
	const url = 'https://kody.codes/password-reset'
	const autofilled = await requestReset(kodyCodes, url, {
		email: 'user@example.com',
		website: 'https://kody.codes',
	})
	expect(autofilled.response.status).toBe(200)
	expect(await Promise.resolve(autofilled.response.data)).toEqual({
		ok: true,
		message: 'If the account exists, a reset email has been sent.',
	})
	await autofilled.flush()

	const honeypot = await requestReset(kodyCodes, url, {
		email: 'user@example.com',
		[honeypotFieldName]: 'https://spam.example',
	})
	expect(honeypot.response.status).toBe(400)
	expect(await Promise.resolve(honeypot.response.data)).toEqual({
		error: 'Unable to submit this form.',
	})
})

test('password reset sends from the configured domain with a link on the right origin, after the response, without logging the token', async () => {
	const cases = [
		{
			name: 'local dev keeps the link on the request origin',
			env: { ...kodyCodes, WRANGLER_IS_LOCAL_DEV: 'true' },
			url: 'http://localhost:3742/password-reset',
			from: 'kody@kody.codes',
			link: 'http://localhost:3742/reset-password?token=',
		},
		{
			name: 'SYSTEM_EMAIL_DOMAIN overrides a legacy APP_BASE_URL',
			env: { ...kodyCodes, APP_BASE_URL: 'https://heykody.dev' },
			url: 'https://heykody.dev/password-reset',
			from: 'kody@kody.codes',
			link: 'https://kody.codes/reset-password?token=',
			htmlOmits: 'heykody.dev',
		},
		{
			name: 'APP_BASE_URL hostname is the sender without a domain override',
			env: { APP_BASE_URL: 'https://app.example.com/path' },
			url: 'https://request-origin.test/password-reset',
			from: 'kody@app.example.com',
			link: 'https://app.example.com/reset-password?token=',
		},
	]
	for (const { name, env, url, from, link, htmlOmits } of cases) {
		mockModule.sendCloudflareEmail.mockClear()
		logAuditEventSpy.mockClear()
		consoleWarn.mockImplementation(() => {})
		const { response, flush } = await requestReset(env, url)
		expect({ name, status: response.status }).toEqual({ name, status: 200 })
		expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
		await flush()

		expect(mockModule.sendCloudflareEmail).toHaveBeenCalledWith(
			{
				accountId: 'account-id',
				apiBaseUrl: 'https://api.cloudflare.test',
				apiToken: 'api-token',
			},
			expect.objectContaining({ from, to: 'user@example.com' }),
		)
		expect(sentMessage().text).toContain(link)
		if (htmlOmits) expect(sentMessage().html).not.toContain(htmlOmits)
		const warned = consoleWarn.mock.calls.map((args) => args.join(' '))
		expect(warned.filter((line) => line.includes('token='))).toEqual([])
		expect(warned.filter((line) => hexTokenPattern.test(line))).toEqual([])
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				category: 'auth',
				action: 'password_reset_request',
				result: 'success',
			}),
		)
	}
})

test('password reset skips sending when APP_BASE_URL is missing and logs a redacted payload', async () => {
	consoleWarn.mockImplementation(() => {})
	const { response, flush } = await requestReset(
		{ APP_BASE_URL: '' },
		'https://request-origin.test/password-reset',
	)
	await flush()

	expect(response.status).toBe(200)
	expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
	const emailMissingCall = consoleWarn.mock.calls.find(
		(args) => args[0] === 'password-reset-email-sender-unconfigured',
	)
	const logPayload = emailMissingCall?.[1] as string
	expect(typeof logPayload).toBe('string')
	for (const leaked of [
		'token=',
		'user@example.com',
		'<html',
		'reset-password',
	]) {
		expect(logPayload).not.toContain(leaked)
	}
	expect(logPayload).not.toMatch(hexTokenPattern)
	const parsed = JSON.parse(logPayload) as Record<string, unknown>
	expect(parsed).toHaveProperty('subject')
	expect(parsed.to).toBe('***@example.com')
})

function createTrackingGrantHelpers(
	initialGrants: Array<{ id: string; clientId: string }>,
) {
	const revokedGrantIds = new Array<string>()
	const liveGrants = [...initialGrants]
	return {
		revokedGrantIds,
		liveGrants,
		helpers: {
			listUserGrants: vi.fn(async () => ({
				items: liveGrants.filter(
					(grant) => !revokedGrantIds.includes(grant.id),
				),
			})),
			revokeGrant: vi.fn(async (grantId: string) => {
				revokedGrantIds.push(grantId)
			}),
		},
	}
}

function confirm(
	oauthProvider: unknown,
	options: { hardBounce?: boolean; queries?: Array<string> } = {},
) {
	return confirmWebsitePasswordReset({
		env: createEnv({ OAUTH_PROVIDER: oauthProvider, ...kodyCodes }, options),
		request: new Request('https://example.com/password-reset/confirm'),
		url: new URL('https://example.com/password-reset/confirm'),
		body: { token: 'a'.repeat(64), password: 'new-password-123' },
	})
}

test('password reset confirm revokes MCP grants before stamping password_changed_at', async () => {
	const { helpers, revokedGrantIds } = createTrackingGrantHelpers([
		{ id: 'grant-1', clientId: 'client-a' },
		{ id: 'grant-2', clientId: 'client-b' },
	])
	const response = await confirm(helpers)

	expect(response.status).toBe(200)
	expect(await Promise.resolve(response.data)).toEqual({ ok: true })
	expect(helpers.listUserGrants).toHaveBeenCalledWith('a'.repeat(64), {
		cursor: undefined,
	})
	expect(revokedGrantIds).toEqual(['grant-1', 'grant-2'])
	expect(mockModule.update).toHaveBeenCalledWith(
		{},
		123,
		expect.objectContaining({ password_changed_at: expect.any(String) }),
	)
	expect(mockModule.deleteMany).toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'success',
			reason: 'two_factor=0;passkeys=0;oauth_connections=0',
		}),
	)
	expect(sentMessage()).toMatchObject({
		to: 'user@example.com',
		from: 'kody@kody.codes',
	})
	expect(sentMessage().text).toContain(
		'Two-factor authentication, passkeys, and linked sign-in providers were removed',
	)
})

test('password reset confirm revokes a grant created between first revoke and password_changed_at', async () => {
	const { helpers, revokedGrantIds, liveGrants } = createTrackingGrantHelpers([
		{ id: 'grant-a', clientId: 'client-a' },
	])
	mockModule.update.mockImplementationOnce(async () => {
		liveGrants.push({ id: 'grant-raced', clientId: 'client-b' })
	})
	const response = await confirm(helpers)

	expect(response.status).toBe(200)
	expect(revokedGrantIds).toEqual(['grant-a', 'grant-raced'])
	expect(mockModule.update).toHaveBeenCalled()
	expect(mockModule.deleteMany).toHaveBeenCalled()
})

test('password reset confirm fails closed when MCP grants cannot be revoked', async () => {
	const response = await confirm({
		listUserGrants: async () => ({
			items: [{ id: 'grant-1', clientId: 'client-a' }],
		}),
		revokeGrant: async () => {
			throw new Error('kv unavailable')
		},
	})

	expect(response.status).toBe(500)
	expect(await Promise.resolve(response.data)).toEqual({
		error: 'Unable to finish password reset right now.',
	})
	expect(mockModule.update).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			reason: 'kv unavailable',
		}),
	)
})

const genericResetResponse = {
	ok: true,
	message: 'If the account exists, a reset email has been sent.',
}

test('a hard-bounced address skips the reset email and still returns the generic response', async () => {
	const queries: Array<string> = []
	const { response, flush } = await requestReset(
		kodyCodes,
		'https://kody.codes/password-reset',
		{ email: 'user@example.com' },
		{ hardBounce: true, queries },
	)
	expect(response.status).toBe(200)
	expect(await Promise.resolve(response.data)).toEqual(genericResetResponse)
	expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
	await flush()
	expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
	expect(queries.join('\n')).not.toMatch(/_rate_limits|verify-email:recipient/)
	const logged = consoleInfo.mock.calls.find(
		(args) => args[0] === 'password-reset-hard-bounce-suppressed',
	)
	expect(logged?.[1]).toBe(
		JSON.stringify({
			to: '***@example.com',
			kind: 'password_reset',
		}),
	)
	expect(String(logged?.[1])).not.toContain('user@example.com')
})

test('password reset confirmation skips a hard-bounced address without consuming the verification cap', async () => {
	const queries: Array<string> = []
	const { helpers } = createTrackingGrantHelpers([
		{ id: 'grant-1', clientId: 'client-a' },
	])
	const response = await confirm(helpers, { hardBounce: true, queries })
	expect(response.status).toBe(200)
	expect(await Promise.resolve(response.data)).toEqual({ ok: true })
	expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
	expect(queries.join('\n')).not.toMatch(/_rate_limits|verify-email:recipient/)
	expect(consoleInfo.mock.calls).toContainEqual([
		'password-reset-hard-bounce-suppressed',
		JSON.stringify({
			to: '***@example.com',
			kind: 'password_reset_confirmed',
		}),
	])
})

test('a delivered password reset does not consume the verification cap', async () => {
	const queries: Array<string> = []
	const { response, flush } = await requestReset(
		kodyCodes,
		'https://kody.codes/password-reset',
		{ email: 'user@example.com' },
		{ queries },
	)
	expect(await Promise.resolve(response.data)).toEqual(genericResetResponse)
	await flush()
	expect(mockModule.sendCloudflareEmail).toHaveBeenCalledOnce()
	expect(queries.join('\n')).not.toMatch(/_rate_limits|verify-email:recipient/)
})
