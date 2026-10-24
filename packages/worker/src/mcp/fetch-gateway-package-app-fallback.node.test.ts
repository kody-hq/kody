import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	GatewayCredentialUnavailableError,
	isPlaceholderAuthorityFailure,
} from '#mcp/fetch-gateway.ts'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import { PackageAppRunsAsUnavailableError } from '#worker/package-runtime/package-app-authority.ts'

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
