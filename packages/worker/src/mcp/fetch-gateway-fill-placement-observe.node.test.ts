/**
 * Observe mode: fills still succeed, but durable would-block records are
 * scheduled when a placeholder site is outside the credential's stored placement.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as credentialResolver from '#worker/credentials/credential-resolver.ts'
import * as orgsRepo from '#worker/orgs/repo.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import * as observations from '#worker/credentials/fill-placement-observations.ts'

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('cloudflare:workers')>()
	return {
		...actual,
		waitUntil: (promise: Promise<unknown>) => {
			void promise
		},
	}
})

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

function mockSecret(placement: secretService.ResolvedSecret['placement']) {
	const secret: secretService.ResolvedSecret = {
		credentialId: 'cred-apiKey',
		found: true,
		value: 'sk_live',
		scope: 'user',
		allowedHosts: ['api.example.com'],
		allowedPackages: [],
		placement,
		placementOrigin: null,
	}
	const { value: _value, ...found } = secret
	return {
		secret,
		findSpy: vi.spyOn(secretService, 'findSecretForUse').mockResolvedValue({
			found,
			readValue: async () => secret,
		}),
		authSpy: vi
			.spyOn(credentialResolver, 'authorizeActorUse')
			.mockResolvedValue(undefined),
		orgSpy: vi
			.spyOn(orgsRepo, 'loadOrgBindingForOrg')
			.mockResolvedValue({ orgId: ownerIdFromStored('user-123') } as never),
	}
}

test('headers-only placement still fills body but records would-block', async () => {
	const schedule = vi
		.spyOn(observations, 'scheduleFillPlacementObservation')
		.mockImplementation(() => {})
	const { findSpy, authSpy, orgSpy } = mockSecret({ headers: true })
	try {
		const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
			request: new Request('https://api.example.com/v1', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:apiKey}}',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ token: '{{secret:apiKey}}' }),
			}),
			props,
			env,
		})
		expect(expanded.headers.get('Authorization')).toBe('Bearer sk_live')
		if (expanded.body) {
			expect(JSON.parse(await expanded.clone().text())).toEqual({
				token: 'sk_live',
			})
		}
		await bodyFillDone
		expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: 'cred-apiKey',
				filledParts: ['headers'],
				wouldBlockParts: [],
			}),
		)
		expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: 'cred-apiKey',
				filledParts: [],
				wouldBlockParts: ['body'],
			}),
		)
	} finally {
		schedule.mockRestore()
		findSpy.mockRestore()
		authSpy.mockRestore()
		orgSpy.mockRestore()
	}
})

test('path and query fills are observed as distinct sites', async () => {
	const schedule = vi
		.spyOn(observations, 'scheduleFillPlacementObservation')
		.mockImplementation(() => {})
	const { findSpy, authSpy, orgSpy } = mockSecret({ headers: true })
	try {
		const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
			request: new Request(
				'https://api.example.com/{{secret:apiKey}}?q={{secret:apiKey}}',
				{
					headers: { Authorization: 'Bearer {{secret:apiKey}}' },
				},
			),
			props,
			env,
		})
		expect(expanded.headers.get('Authorization')).toBe('Bearer sk_live')
		expect(new URL(expanded.url).pathname).toContain('sk_live')
		expect(new URL(expanded.url).searchParams.get('q')).toBe('sk_live')
		await bodyFillDone
		expect(schedule).toHaveBeenCalledTimes(1)
		expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: 'cred-apiKey',
				filledParts: ['headers'],
				wouldBlockParts: ['path', 'query'],
			}),
		)
	} finally {
		schedule.mockRestore()
		findSpy.mockRestore()
		authSpy.mockRestore()
		orgSpy.mockRestore()
	}
})

test('null placement (anywhere) does not record would-block', async () => {
	const schedule = vi
		.spyOn(observations, 'scheduleFillPlacementObservation')
		.mockImplementation(() => {})
	const { findSpy, authSpy, orgSpy } = mockSecret(null)
	try {
		const { request: expanded, bodyFillDone } = await expandSecretPlaceholders({
			request: new Request('https://api.example.com/v1', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer {{secret:apiKey}}',
					'Content-Type': 'text/plain',
				},
				body: 'token={{secret:apiKey}}',
			}),
			props,
			env,
		})
		expect(expanded.headers.get('Authorization')).toBe('Bearer sk_live')
		expect(await expanded.text()).toBe('token=sk_live')
		await bodyFillDone
		expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				filledParts: ['headers'],
				wouldBlockParts: [],
			}),
		)
		expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({
				filledParts: ['body'],
				wouldBlockParts: [],
			}),
		)
		expect(schedule).not.toHaveBeenCalledWith(
			expect.objectContaining({
				wouldBlockParts: expect.arrayContaining(['body']),
			}),
		)
	} finally {
		schedule.mockRestore()
		findSpy.mockRestore()
		authSpy.mockRestore()
		orgSpy.mockRestore()
	}
})
