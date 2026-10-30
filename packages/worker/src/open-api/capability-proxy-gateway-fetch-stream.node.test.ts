import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { ApiError } from './errors.ts'
import { nativeApiOperationDefinitions } from './native-operations.ts'
import {
	assertGatewayFetchContentLength,
	gatewayFetchHeadersHeaderName,
	gatewayFetchMethodHeaderName,
	gatewayFetchPackageIdHeaderName,
	gatewayFetchUrlHeaderName,
	maxGatewayFetchUploadBytes,
	parseCapabilityProxyGatewayFetchStreamHeaders,
	runCapabilityProxyGatewayFetchStream,
} from './capability-proxy-gateway-fetch-stream.ts'

const authorizeLocalExecutePackageBinding = vi.hoisted(() => vi.fn())
const executeGatewayFetch = vi.hoisted(() => vi.fn())

vi.mock('./capability-proxy-package-grants.ts', () => ({
	authorizeLocalExecutePackageBinding: (...args: Array<unknown>) =>
		authorizeLocalExecutePackageBinding(...args),
}))

vi.mock('#mcp/fetch-gateway.ts', () => ({
	secretResolutionHeaderName: 'x-kody-secret-resolution',
	executeGatewayFetch: (...args: Array<unknown>) =>
		executeGatewayFetch(...args),
}))

function streamHeaders(input: Record<string, string> = {}) {
	return new Headers({
		[gatewayFetchUrlHeaderName]: 'https://example.com/upload',
		...input,
	})
}

test('parseCapabilityProxyGatewayFetchStreamHeaders reads metadata and rejects bad input', () => {
	expect(
		parseCapabilityProxyGatewayFetchStreamHeaders(streamHeaders()),
	).toEqual({
		url: 'https://example.com/upload',
		method: 'GET',
	})
	expect(
		parseCapabilityProxyGatewayFetchStreamHeaders(
			streamHeaders({
				[gatewayFetchMethodHeaderName]: 'POST',
				[gatewayFetchPackageIdHeaderName]: 'pkg-1',
				[gatewayFetchHeadersHeaderName]: JSON.stringify({
					authorization: 'Bearer {{secret:demo}}',
				}),
			}),
		),
	).toEqual({
		url: 'https://example.com/upload',
		method: 'POST',
		packageId: 'pkg-1',
		headers: { authorization: 'Bearer {{secret:demo}}' },
	})
	expect(() =>
		parseCapabilityProxyGatewayFetchStreamHeaders(new Headers()),
	).toThrow(ApiError)
	expect(() =>
		parseCapabilityProxyGatewayFetchStreamHeaders(new Headers()),
	).toThrow(/X-Kody-Gateway-Url/)
	expect(() =>
		parseCapabilityProxyGatewayFetchStreamHeaders(
			streamHeaders({ [gatewayFetchUrlHeaderName]: 'not-a-url' }),
		),
	).toThrow(/absolute URL/)
	expect(() =>
		parseCapabilityProxyGatewayFetchStreamHeaders(
			streamHeaders({ [gatewayFetchHeadersHeaderName]: '{not-json' }),
		),
	).toThrow(/valid JSON/)
	expect(() =>
		parseCapabilityProxyGatewayFetchStreamHeaders(
			streamHeaders({
				[gatewayFetchHeadersHeaderName]: JSON.stringify({
					authorization: 1,
				}),
			}),
		),
	).toThrow(/must be a string/)
})

test('assertGatewayFetchContentLength names the Worker upload limit', () => {
	assertGatewayFetchContentLength(new Headers())
	expect(() =>
		assertGatewayFetchContentLength(
			new Headers({
				'Content-Length': String(maxGatewayFetchUploadBytes + 1),
			}),
		),
	).toThrow(ApiError)
	try {
		assertGatewayFetchContentLength(
			new Headers({
				'Content-Length': String(maxGatewayFetchUploadBytes + 1),
			}),
		)
	} catch (error) {
		expect(error).toMatchObject({
			status: 413,
			code: 'payload_too_large',
		})
		expect((error as ApiError).message).toMatch(/100 MiB/)
		expect((error as ApiError).message).toContain(
			String(maxGatewayFetchUploadBytes),
		)
	}
})

test('JSON invoke of capabilityProxyGatewayFetch is refused', async () => {
	await expect(
		nativeApiOperationDefinitions.capabilityProxyGatewayFetch.handler(
			{},
			{} as never,
		),
	).rejects.toMatchObject({
		code: 'invalid_request',
		message: expect.stringMatching(/streaming HTTP route/),
	})
})

test('runCapabilityProxyGatewayFetchStream forwards the body stream and returns the upstream Response', async () => {
	authorizeLocalExecutePackageBinding.mockResolvedValue('pkg-owned')
	executeGatewayFetch.mockResolvedValue(
		new Response('upstream-body', {
			status: 201,
			statusText: 'Created',
			headers: { 'content-type': 'text/plain' },
		}),
	)
	const request = new Request(
		'https://api.kody.test/v1/capability-proxy/gateway-fetch',
		{
			method: 'POST',
			headers: {
				[gatewayFetchUrlHeaderName]: 'https://example.com/upload',
				[gatewayFetchMethodHeaderName]: 'POST',
				[gatewayFetchPackageIdHeaderName]: 'pkg-owned',
				[gatewayFetchHeadersHeaderName]: JSON.stringify({
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				}),
				'x-kody-secret-resolution': 'headers-only',
				'Content-Type': 'text/plain',
			},
			body: 'raw-bytes',
		},
	)
	const response = await runCapabilityProxyGatewayFetchStream({
		ctx: {
			env: { APP_DB: {} },
			principal: { kind: 'token', token: {} },
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: {
					userId: ownerIdFromStored('user-1'),
					email: 'user@example.com',
				},
				storageContext: null,
			},
		} as never,
		request,
	})
	expect(response.status).toBe(201)
	expect(await response.text()).toBe('upstream-body')
	expect(authorizeLocalExecutePackageBinding).toHaveBeenCalledWith(
		expect.objectContaining({
			orgUserId: ownerIdFromStored('user-1'),
			packageBinding: 'pkg-owned',
		}),
	)
	expect(executeGatewayFetch).toHaveBeenCalledTimes(1)
	const gatewayArg = executeGatewayFetch.mock.calls[0]?.[0] as {
		request: Request
		props: {
			claimedPackageId?: string | null
			storageContext: { packageId: string | null }
		}
	}
	expect(gatewayArg.props.claimedPackageId).toBe('pkg-owned')
	expect(gatewayArg.props.storageContext.packageId).toBeNull()
	expect(gatewayArg.request.url).toBe('https://example.com/upload')
	expect(gatewayArg.request.method).toBe('POST')
	expect(gatewayArg.request.headers.get('content-type')).toBe('text/plain')
	expect(gatewayArg.request.headers.get('authorization')).toBe(
		'Bearer {{secret:demoToken|scope=user}}',
	)
	expect(gatewayArg.request.headers.get('x-kody-secret-resolution')).toBe(
		'headers-only',
	)
	expect(gatewayArg.request.headers.get('x-kody-secret-authority')).toBeNull()
	expect(await gatewayArg.request.text()).toBe('raw-bytes')
})

test('runCapabilityProxyGatewayFetchStream propagates missing-secret caller errors', async () => {
	executeGatewayFetch.mockRejectedValue(
		new McpCallerError('Secret "demoToken" was not found.'),
	)
	await expect(
		runCapabilityProxyGatewayFetchStream({
			ctx: {
				env: { APP_DB: {} },
				principal: { kind: 'token', token: {} },
				callerContext: {
					baseUrl: 'https://heykody.dev',
					user: {
						userId: ownerIdFromStored('user-1'),
						email: 'user@example.com',
					},
					storageContext: null,
				},
			} as never,
			request: new Request(
				'https://api.kody.test/v1/capability-proxy/gateway-fetch',
				{
					method: 'POST',
					headers: {
						[gatewayFetchUrlHeaderName]: 'https://example.com/upload',
					},
				},
			),
		}),
	).rejects.toMatchObject({
		message: 'Secret "demoToken" was not found.',
	})
})

function contextRunStream(credentials: unknown) {
	return runCapabilityProxyGatewayFetchStream({
		ctx: {
			env: { APP_DB: {} },
			principal: {
				kind: 'execution-context-run',
				ecid: 'ec-1',
				runId: 'run-1',
				deadline: Date.now() + 60_000,
				scopes: null,
				runtime: { mode: 'all' },
				credentials,
			},
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: {
					userId: ownerIdFromStored('user-1'),
					email: 'user@example.com',
				},
				storageContext: null,
			},
		} as never,
		request: new Request(
			'https://api.kody.test/v1/capability-proxy/gateway-fetch',
			{
				method: 'POST',
				headers: {
					[gatewayFetchUrlHeaderName]: 'https://example.com/upload',
					[gatewayFetchHeadersHeaderName]: JSON.stringify({
						authorization: 'Bearer {{secret:demoToken}}',
					}),
				},
				body: 'raw-bytes',
			},
		),
	})
}

test("runCapabilityProxyGatewayFetchStream lets only the operator's own context runs use credentials", async () => {
	executeGatewayFetch.mockReset()
	await expect(contextRunStream('none')).rejects.toMatchObject({
		status: 403,
		code: 'execution_context_credential_not_granted',
	})
	expect(executeGatewayFetch).not.toHaveBeenCalled()

	executeGatewayFetch.mockImplementation(async () => new Response('ok'))
	const response = await contextRunStream('requester')
	expect(await response.text()).toBe('ok')
	expect(executeGatewayFetch).toHaveBeenCalledTimes(1)
})
