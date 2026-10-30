import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

// These cases cover fills the owner has opted in to; enforcement of the
// opt-in itself is covered in fill-placement-enforcement.node.test.ts.
vi.mock(
	'#worker/credentials/fill-placement-opt-ins.ts',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('#worker/credentials/fill-placement-opt-ins.ts')
		>()),
		readFillPlacementOptIn: async () => ({
			query: true,
			path: true,
			body: true,
		}),
	}),
)

const userMeter = createInMemoryUserMeterEnv()
const env = {
	APP_DB: {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							if (isActiveOrgQuery(normalizedQuery)) return { ok: 1 }
							if (isOrgBindingMembershipQuery(normalizedQuery)) {
								return mockPersonalOrgBindingRow(String(params[1]), 'ada')
							}
							if (
								normalizedQuery.includes('where stable_user_id') &&
								params[0] !== 'user-123'
							) {
								throw new Error(
									'Account reverse-resolution must bind the acting userId.',
								)
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
	...userMeter.env,
	COOKIE_SECRET: 'test-cookie-secret',
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	// Opt out of credential-resolution audit writes in this fixture.
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

const props = {
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-123'),
	email: null,
	request: sessionRequestContext('user-123', 'ada'),
	storageContext: null,
}

const resolvePlacement = vi.hoisted(() => vi.fn())
vi.mock('#mcp/credential-client-gateway.ts', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('#mcp/credential-client-gateway.ts')
	>()),
	resolveCredentialClientPlacement: resolvePlacement,
}))

function loginPlacement(session: string, sessionId: string | null) {
	return {
		placement: {
			kind: 'header' as const,
			name: 'Authorization',
			value: `Bearer ${session}`,
		},
		substitutedValues: [session, `Bearer ${session}`],
		shape: 'Authorization: Bearer <session>',
		login: { sessionId },
	}
}

function clientRequest(init: RequestInit = {}) {
	return new Request('https://api.example.com/v1/reports', {
		...init,
		headers: { [credentialClientHeaderName]: 'dummy-client-token' },
	})
}

function upstream(statuses: Array<number>) {
	const seen: Array<string | null> = []
	const fetchStub = vi.fn(async (request: Request) => {
		seen.push(request.headers.get('authorization'))
		return new Response('dummy-access-1 echoed', {
			status: statuses[seen.length - 1] ?? 200,
		})
	})
	return { seen, fetchStub }
}

test('a 401 to a login session drops it, signs in once more, and retries once', async () => {
	resolvePlacement.mockReset()
	resolvePlacement
		.mockResolvedValueOnce(loginPlacement('dummy-access-1', 'session-1'))
		.mockResolvedValueOnce(loginPlacement('dummy-access-2', 'session-2'))
	const { seen, fetchStub } = upstream([401, 200])
	const response = await executeGatewayFetch({
		env,
		props,
		request: clientRequest(),
		globalFetch: fetchStub as unknown as typeof fetch,
	})
	expect(response.status).toBe(200)
	expect(seen).toEqual(['Bearer dummy-access-1', 'Bearer dummy-access-2'])
	expect(resolvePlacement).toHaveBeenCalledTimes(2)
	expect(resolvePlacement.mock.calls[1]?.[0]).toMatchObject({
		rejectedLoginSessionId: 'session-1',
	})
	// Echoes of either session are redacted.
	expect(await response.text()).not.toContain('dummy-access-1')
})

test('a second 401 is returned as is: the retry never loops', async () => {
	resolvePlacement.mockReset()
	resolvePlacement
		.mockResolvedValueOnce(loginPlacement('dummy-access-1', 'session-1'))
		.mockResolvedValueOnce(loginPlacement('dummy-access-2', 'session-2'))
	const { seen, fetchStub } = upstream([401, 401, 200])
	const response = await executeGatewayFetch({
		env,
		props,
		request: clientRequest(),
		globalFetch: fetchStub as unknown as typeof fetch,
	})
	expect(response.status).toBe(401)
	expect(seen).toHaveLength(2)
	expect(resolvePlacement).toHaveBeenCalledTimes(2)
})

test('a request with a body, or a credential that is not a login, is not retried', async () => {
	resolvePlacement.mockReset()
	resolvePlacement.mockResolvedValue(
		loginPlacement('dummy-access-1', 'session-1'),
	)
	const withBody = upstream([401, 200])
	const response = await executeGatewayFetch({
		env,
		props,
		request: clientRequest({ method: 'POST', body: 'report=1' }),
		globalFetch: withBody.fetchStub as unknown as typeof fetch,
	})
	expect(response.status).toBe(401)
	expect(withBody.seen).toHaveLength(1)

	resolvePlacement.mockReset()
	resolvePlacement.mockResolvedValue({
		...loginPlacement('dummy-key', null),
		login: undefined,
	})
	const key = upstream([401, 200])
	const keyResponse = await executeGatewayFetch({
		env,
		props,
		request: clientRequest(),
		globalFetch: key.fetchStub as unknown as typeof fetch,
	})
	expect(keyResponse.status).toBe(401)
	expect(key.seen).toHaveLength(1)
	expect(resolvePlacement).toHaveBeenCalledTimes(1)
})

test('a refused retry (host or placement no longer allowed) surfaces the refusal', async () => {
	resolvePlacement.mockReset()
	resolvePlacement
		.mockResolvedValueOnce(loginPlacement('dummy-access-1', 'session-1'))
		.mockRejectedValueOnce(new Error('Credential host not allowed.'))
	const { seen, fetchStub } = upstream([401, 200])
	await expect(
		executeGatewayFetch({
			env,
			props,
			request: clientRequest(),
			globalFetch: fetchStub as unknown as typeof fetch,
		}),
	).rejects.toThrow('Credential host not allowed.')
	expect(seen).toHaveLength(1)
})
