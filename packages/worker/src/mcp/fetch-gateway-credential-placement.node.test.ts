/**
 * Fetch-gateway placeholder fills tell resolveCredential where the
 * placeholder sat, so each credential.resolve row can record placement.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import type { ResolvedSecret } from '#mcp/secrets/service.ts'
import * as credentialResolution from '#worker/credentials/resolve-credential.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const env = {
	APP_DB: {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							return { meta: { changes: 0 } }
						},
						async first() {
							return null
						},
						async all() {
							return { results: [] }
						},
					}
				},
			}
		},
	},
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

const props = {
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-123'),
	email: null,
	request: sessionRequestContext('user-123', 'ada'),
	storageContext: null,
}

async function expand(request: Request) {
	const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
		request,
		props,
		env,
	})
	if (expanded.body) {
		await expanded.clone().arrayBuffer()
	}
	await bodyFillDone
	return expanded
}

function fetchPlacements(
	credential: Parameters<
		typeof credentialResolution.resolveCredential
	>[0]['credential'],
) {
	if (
		credential.use === 'secret' ||
		credential.use === 'integration-token' ||
		credential.use === 'provider-secret'
	) {
		return credential.placements
	}
	throw new Error(`Unexpected credential use: ${credential.use}`)
}

function foundSecret(value: string): ResolvedSecret {
	return {
		credentialId: `cred-${value}`,
		found: true,
		value,
		scope: 'user',
		allowedHosts: ['api.example.com'],
		allowedPackages: [],
		placement: null,
	}
}

test('header, url, and body placements are passed through, and a repeated body place skips another read', async () => {
	const resolveSpy = vi
		.spyOn(credentialResolution, 'resolveCredential')
		.mockImplementation(async ({ credential }) => {
			if (credential.use === 'secret') return foundSecret('api-key-value')
			if (credential.use === 'integration-token') return 'gho_value'
			if (credential.use === 'provider-secret') {
				return {
					provider: credential.provider,
					ref: credential.ref,
					canonicalRef: credential.ref,
					value: 'vault-value',
					hosts: ['api.example.com'],
				}
			}
			throw new Error(`Unexpected credential use: ${credential.use}`)
		})
	const repeatSpy = vi
		.spyOn(credentialResolution, 'auditResolvedFetchPlacements')
		.mockReturnValue(true)
	try {
		const sent = await expand(
			new Request('https://api.example.com/v1?q={{secret:apiKey}}', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:apiKey}}',
					'X-Token': '{{integration-token:github}}',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					password: '{{secret:apiKey}}',
					vault: '{{secret/1password:item-1}}',
				}),
			}),
		)

		expect(sent.headers.get('Authorization')).toBe('Bearer api-key-value')
		expect(sent.headers.get('X-Token')).toBe('gho_value')
		expect(new URL(sent.url).searchParams.get('q')).toBe('api-key-value')
		expect(JSON.parse(await sent.text())).toEqual({
			password: 'api-key-value',
			vault: 'vault-value',
		})
		expect(resolveSpy.mock.calls.map((call) => call[0].credential)).toEqual([
			expect.objectContaining({
				use: 'secret',
				name: 'apiKey',
				requestHost: 'api.example.com',
				placements: [
					{ kind: 'header', name: 'authorization' },
					{ kind: 'url' },
				],
				fillSites: [
					{ part: 'header', name: 'authorization' },
					{ part: 'query' },
				],
			}),
			expect.objectContaining({
				use: 'integration-token',
				name: 'github',
				placements: [{ kind: 'header', name: 'x-token' }],
				fillSites: [{ part: 'header', name: 'x-token' }],
			}),
			expect.objectContaining({
				use: 'provider-secret',
				provider: '1password',
				ref: 'item-1',
				placements: [{ kind: 'body' }],
				fillSites: [{ part: 'body' }],
			}),
		])
		expect(repeatSpy).toHaveBeenCalledTimes(1)
		expect(repeatSpy.mock.calls[0]?.[0].credential).toMatchObject({
			use: 'secret',
			name: 'apiKey',
			placements: [{ kind: 'body' }],
			fillSites: [{ part: 'body' }],
		})
	} finally {
		resolveSpy.mockRestore()
		repeatSpy.mockRestore()
	}
})

test('a repeated place resolves again when this request has no cached audit', async () => {
	const resolveSpy = vi
		.spyOn(credentialResolution, 'resolveCredential')
		.mockImplementation(async ({ credential }) => {
			if (credential.use !== 'secret') {
				throw new Error(`Unexpected credential use: ${credential.use}`)
			}
			return foundSecret('api-key-value')
		})
	const repeatSpy = vi
		.spyOn(credentialResolution, 'auditResolvedFetchPlacements')
		.mockReturnValue(false)
	try {
		const sent = await expand(
			new Request('https://api.example.com/v1', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:apiKey}}',
					'Content-Type': 'text/plain',
				},
				body: 'token={{secret:apiKey}}',
			}),
		)
		expect(sent.headers.get('Authorization')).toBe('Bearer api-key-value')
		expect(await sent.text()).toBe('token=api-key-value')
		expect(
			resolveSpy.mock.calls.map((call) => fetchPlacements(call[0].credential)),
		).toEqual([[{ kind: 'header', name: 'authorization' }], [{ kind: 'body' }]])
		expect(repeatSpy).toHaveBeenCalledTimes(1)
	} finally {
		resolveSpy.mockRestore()
		repeatSpy.mockRestore()
	}
})

test('headers-only records the header placement and leaves the url and body unresolved', async () => {
	const resolveSpy = vi
		.spyOn(credentialResolution, 'resolveCredential')
		.mockResolvedValue(foundSecret('secret-value'))
	const repeatSpy = vi.spyOn(
		credentialResolution,
		'auditResolvedFetchPlacements',
	)
	try {
		const body = 'Use {{secret:apiKey}} in a header.'
		const sent = await expand(
			new Request('https://api.example.com/v1?q={{secret:apiKey}}', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:apiKey}}',
					'Content-Type': 'text/plain',
					'x-kody-secret-resolution': 'headers-only',
				},
				body,
			}),
		)
		expect(sent.headers.get('Authorization')).toBe('Bearer secret-value')
		expect(new URL(sent.url).searchParams.get('q')).toBe('{{secret:apiKey}}')
		expect(await sent.text()).toBe(body)
		expect(resolveSpy).toHaveBeenCalledTimes(1)
		expect(resolveSpy.mock.calls[0]?.[0].credential).toMatchObject({
			use: 'secret',
			name: 'apiKey',
			placements: [{ kind: 'header', name: 'authorization' }],
		})
		expect(repeatSpy).not.toHaveBeenCalled()
	} finally {
		resolveSpy.mockRestore()
		repeatSpy.mockRestore()
	}
})

test('basic auth username and password share the header placement', async () => {
	const resolveSpy = vi
		.spyOn(credentialResolution, 'resolveCredential')
		.mockImplementation(async ({ credential }) => {
			if (credential.use !== 'secret') {
				throw new Error(`Unexpected credential use: ${credential.use}`)
			}
			return foundSecret(
				credential.name === 'userId' ? 'user-value' : 'pass-value',
			)
		})
	try {
		const sent = await expand(
			new Request('https://api.example.com/v1', {
				headers: {
					Authorization: '{{secret-basic:username=userId,password=pass}}',
				},
			}),
		)
		expect(sent.headers.get('Authorization')).toBe(
			`Basic ${btoa('user-value:pass-value')}`,
		)
		expect(resolveSpy.mock.calls.map((call) => call[0].credential)).toEqual([
			expect.objectContaining({
				use: 'secret',
				name: 'userId',
				placements: [{ kind: 'header', name: 'authorization' }],
			}),
			expect.objectContaining({
				use: 'secret',
				name: 'pass',
				placements: [{ kind: 'header', name: 'authorization' }],
			}),
		])
	} finally {
		resolveSpy.mockRestore()
	}
})
