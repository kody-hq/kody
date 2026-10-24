import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	expandSecretPlaceholders,
	GatewayCredentialUnavailableError,
	isPlaceholderAuthorityFailure,
} from '#mcp/fetch-gateway.ts'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import * as credentialResolution from '#worker/credentials/resolve-credential.ts'
import { PackageAppRunsAsUnavailableError } from '#worker/package-runtime/package-app-authority.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

test('placeholder authority failures stay failures; they never retry as the visitor', () => {
	expect(
		isPlaceholderAuthorityFailure(
			new GatewayCredentialUnavailableError('missing secret'),
		),
	).toBe(true)
	expect(
		isPlaceholderAuthorityFailure(new McpCallerError('secret not found')),
	).toBe(true)
	expect(
		isPlaceholderAuthorityFailure(
			new SecretPlacementError('not allowed here', 'token'),
		),
	).toBe(true)
	expect(
		isPlaceholderAuthorityFailure(
			new PackageAppRunsAsUnavailableError('person-unavailable'),
		),
	).toBe(false)

	expect(isPlaceholderAuthorityFailure(new Error('D1 is unavailable'))).toBe(
		false,
	)
	expect(
		isPlaceholderAuthorityFailure(new TypeError('Too many redirects.')),
	).toBe(false)
})

const env = {
	APP_DB: {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							return null
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database,
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

test('a streamed body placeholder the actor cannot fill fails closed', async () => {
	const resolveCredential = vi
		.spyOn(credentialResolution, 'resolveCredential')
		.mockRejectedValue(new McpCallerError('Secret "token" was not found.'))
	const expanded = await expandSecretPlaceholders({
		request: new Request('https://api.example.com/v1/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refresh_token: '{{secret:token}}' }),
		}),
		props: {
			baseUrl: 'https://example.com',
			userId: ownerIdFromStored('user-123'),
			email: null,
			request: sessionRequestContext('publisher-1', 'grace'),
			storageContext: null,
		},
		env,
	})
	await expect(expanded.request.text()).rejects.toThrow(
		/Secret "token" was not found/,
	)
	await expect(expanded.bodyFillDone).rejects.toThrow(
		/Secret "token" was not found/,
	)
	resolveCredential.mockRestore()
})
