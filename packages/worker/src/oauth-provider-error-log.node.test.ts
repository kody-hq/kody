import { expect, test } from 'vitest'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import {
	oauthProviderErrorAuditReason,
	reportOAuthProviderError,
	safeClientIdFromBasicAuthorization,
	shouldReportOAuthProviderError,
} from '#worker/oauth-provider-error-log.ts'

test('shouldReportOAuthProviderError keeps refresh and invalid_grant reasons', () => {
	expect(
		shouldReportOAuthProviderError({
			code: 'invalid_grant',
			internal: {
				category: 'refresh-token-grant',
				reason: 'grant_not_found',
			},
		}),
	).toBe(true)
	expect(
		shouldReportOAuthProviderError({
			code: 'invalid_grant',
			internal: {
				category: 'refresh-token-grant',
				reason: 'refresh_token_mismatch',
			},
		}),
	).toBe(true)
	expect(
		shouldReportOAuthProviderError({
			code: 'invalid_request',
			internal: {
				category: 'token-endpoint-request',
				reason: 'method_not_allowed',
			},
		}),
	).toBe(false)
	expect(
		shouldReportOAuthProviderError({
			code: 'invalid_client',
			internal: {
				category: 'client-id-metadata-document',
				reason: 'metadata_resolution_failed',
			},
		}),
	).toBe(false)
	expect(
		shouldReportOAuthProviderError({
			code: 'invalid_token',
			internal: {
				category: 'protected-resource',
				reason: 'token_not_found',
			},
		}),
	).toBe(false)
})

test('safeClientIdFromBasicAuthorization returns only the client id half', () => {
	expect(
		safeClientIdFromBasicAuthorization(
			`Basic ${btoa(
				`${encodeURIComponent('https://chatgpt.com/oauth/client.json')}:${encodeURIComponent('super-secret')}`,
			)}`,
		),
	).toBe('https://chatgpt.com/oauth/client.json')
	expect(
		safeClientIdFromBasicAuthorization(
			`Basic ${btoa('demo-client:client-secret-value')}`,
		),
	).toBe('demo-client')
	expect(safeClientIdFromBasicAuthorization('Bearer abc')).toBeUndefined()
})

test('reportOAuthProviderError logs reason and client without secrets', async () => {
	consoleInfo.mockClear()
	logAuditEventSpy.mockClear()

	const secret = 'rt_should_never_appear_in_logs'
	const request = new Request('https://heykody.dev/oauth/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: `Basic ${btoa('demo-client:client-secret-value')}`,
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: secret,
			client_secret: 'also-secret',
		}),
	})

	await reportOAuthProviderError({
		code: 'invalid_grant',
		description: 'Invalid refresh token',
		status: 400,
		headers: {},
		internal: {
			category: 'refresh-token-grant',
			reason: 'grant_not_found',
			detail: { refresh_token: secret },
		},
		request,
	})

	const infoPayload = consoleInfo.mock.calls
		.filter((call) => call[0] === 'oauth-provider-error')
		.map((call) => String(call[1]))
		.join('\n')
	expect(infoPayload).toContain('grant_not_found')
	expect(infoPayload).toContain('demo-client')
	expect(infoPayload).not.toContain(secret)
	expect(infoPayload).not.toContain('client-secret-value')
	expect(infoPayload).not.toContain('also-secret')

	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'oauth',
			action: 'token_error',
			result: 'failure',
			clientId: 'demo-client',
			path: '/oauth/token',
			reason: oauthProviderErrorAuditReason({
				code: 'invalid_grant',
				internal: {
					category: 'refresh-token-grant',
					reason: 'grant_not_found',
				},
			}),
		}),
	)

	const auditArgs = JSON.stringify(logAuditEventSpy.mock.calls)
	expect(auditArgs).not.toContain(secret)
	expect(auditArgs).not.toContain('client-secret-value')
})

test('reportOAuthProviderError skips CIMD metadata noise', async () => {
	consoleInfo.mockClear()
	logAuditEventSpy.mockClear()
	await reportOAuthProviderError({
		code: 'invalid_client',
		description: 'Client authentication failed',
		status: 401,
		headers: {},
		internal: {
			category: 'client-id-metadata-document',
			reason: 'metadata_resolution_failed',
		},
	})
	expect(consoleInfo).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})
