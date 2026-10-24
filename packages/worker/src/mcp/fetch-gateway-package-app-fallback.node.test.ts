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
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

test('a package app fetch falls back to the visitor only when the runs-as person cannot fill a credential', () => {
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
	).toBe(true)

	expect(isPlaceholderAuthorityFailure(new Error('D1 is unavailable'))).toBe(
		false,
	)
	expect(
		isPlaceholderAuthorityFailure(new TypeError('Too many redirects.')),
	).toBe(false)
})

const env = {
	APP_DB: {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							if (isActiveOrgQuery(normalized)) return { ok: 1 }
							if (isOrgBindingMembershipQuery(normalized)) {
								return mockPersonalOrgBindingRow(String(params[1]), 'ada')
							}
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

const visitorProps = {
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-123'),
	email: null,
	request: sessionRequestContext('user-123', 'ada'),
	storageContext: null,
}

test('a streamed body placeholder the runs-as person cannot fill is filled as the visitor', async () => {
	const resolveCredential = vi
		.spyOn(credentialResolution, 'resolveCredential')
		.mockImplementation(async (input) => {
			if (input.actor?.actor?.userId === 'publisher-1') {
				throw new McpCallerError('Secret "token" was not found.')
			}
			return {
				credentialId: 'cred-visitor',
				found: true,
				value: 'visitor-value',
				scope: 'user',
				allowedHosts: ['api.example.com'],
				allowedPackages: [],
				placement: null,
			} as Awaited<ReturnType<typeof credentialResolution.resolveCredential>>
		})
	const onFallback = vi.fn()
	const expanded = await expandSecretPlaceholders({
		request: new Request('https://api.example.com/v1/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refresh_token: '{{secret:token}}' }),
		}),
		props: {
			...visitorProps,
			request: sessionRequestContext('publisher-1', 'grace'),
		},
		env,
		bodyFallback: { props: visitorProps, onFallback },
	})
	expect(await expanded.request.text()).toBe(
		'{"refresh_token":"visitor-value"}',
	)
	await expanded.bodyFillDone
	expect(expanded.substitutedValues).toContain('visitor-value')
	expect(onFallback).toHaveBeenCalledTimes(1)
	expect(onFallback.mock.calls[0]?.[0]).toBeInstanceOf(McpCallerError)
	resolveCredential.mockRestore()
})
