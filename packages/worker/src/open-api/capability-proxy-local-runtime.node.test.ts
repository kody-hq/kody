import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { ApiError } from './errors.ts'
import type { ApiInvocationContext } from './context.ts'
import { runCapabilityProxyCall } from './capability-proxy.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

const mockFns = vi.hoisted(() => ({
	buildKodyToolContext: vi.fn(),
	buildKodyFns: vi.fn(),
	executeGatewayFetch: vi.fn(),
	createAuthenticatedFetch: vi.fn(),
	createCapabilityProxyPackageHostTools: vi.fn(),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	buildKodyToolContext: mockFns.buildKodyToolContext,
	buildKodyFns: mockFns.buildKodyFns,
	createWorkflowTools: () => ({ create: async () => null }),
}))

vi.mock('#mcp/fetch-gateway.ts', () => ({
	executeGatewayFetch: mockFns.executeGatewayFetch,
}))

vi.mock('#mcp/execute-modules/kody-runtime-utils.ts', () => ({
	createAuthenticatedFetch: mockFns.createAuthenticatedFetch,
}))

vi.mock('./capability-proxy-package-grants.ts', () => ({
	createCapabilityProxyPackageHostTools:
		mockFns.createCapabilityProxyPackageHostTools,
}))

const ctx = {
	env: { APP_DB: {} },
	callerContext: {
		baseUrl: 'https://heykody.dev',
		user: { userId: ownerIdFromStored('user-1'), email: 'user@example.com' },
		storageContext: null,
	},
	principal: { kind: 'mcp' },
	getFeatureFlags: async () => ({}),
} as unknown as ApiInvocationContext

afterEach(() => {
	vi.clearAllMocks()
})

test('capability proxy authenticatedFetch expands via createAuthenticatedFetch + gateway fetch', async () => {
	const body = new TextEncoder().encode('{"ok":true}')
	mockFns.createAuthenticatedFetch.mockImplementation(
		async (
			_kody: unknown,
			providerName: string,
			options: { fetch: typeof fetch },
		) => {
			expect(providerName).toBe('google')
			expect(typeof options.fetch).toBe('function')
			return async (url: string, init?: RequestInit) => {
				expect(url).toBe(
					'https://gmail.googleapis.com/gmail/v1/users/me/profile',
				)
				const gatewayResponse = await options.fetch(url, init)
				return gatewayResponse
			}
		},
	)
	mockFns.executeGatewayFetch.mockResolvedValue(
		new Response(body, {
			status: 200,
			statusText: 'OK',
			headers: { 'content-type': 'application/json' },
		}),
	)
	mockFns.buildKodyFns.mockResolvedValue({})

	const result = await runCapabilityProxyCall({
		ctx,
		call: {
			path: ['kody', 'authenticatedFetch'],
			args: [
				{
					providerName: 'google',
					request: {
						url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
						method: 'GET',
						headers: { accept: 'application/json' },
					},
				},
			],
		},
	})

	expect(result).toEqual({
		result: {
			status: 200,
			statusText: 'OK',
			headers: { 'content-type': 'application/json' },
			bodyBase64: bytesToBase64(body),
		},
	})
	expect(mockFns.createAuthenticatedFetch).toHaveBeenCalledTimes(1)
	expect(mockFns.buildKodyToolContext).not.toHaveBeenCalled()

	const rejected = await runCapabilityProxyCall({
		ctx,
		call: { path: ['kody', 'authenticatedFetch'], args: ['google'] },
	}).catch((value: unknown) => value)
	expect(rejected).toBeInstanceOf(ApiError)
	expect(rejected).toMatchObject({ status: 400, code: 'invalid_request' })
})

test('capability proxy packageStorageGet uses local-execute package host tools', async () => {
	mockFns.createCapabilityProxyPackageHostTools.mockResolvedValue({
		packageStorageGet: async (args: { packageId: string; key: string }) => {
			expect(args).toEqual({ packageId: 'pkg-1', key: 'cursor' })
			return { value: 42 }
		},
	})
	mockFns.buildKodyToolContext.mockImplementation(
		async (
			_env: unknown,
			_caller: unknown,
			options: { additionalTools?: Record<string, unknown> },
		) => ({
			mcpServers: [],
			tools: {
				...options.additionalTools,
			},
		}),
	)

	const result = await runCapabilityProxyCall({
		ctx,
		call: {
			path: ['kody', 'packageStorageGet'],
			args: [{ packageId: 'pkg-1', key: 'cursor' }],
		},
	})
	expect(result).toEqual({ result: { value: 42 } })
	expect(mockFns.createCapabilityProxyPackageHostTools).toHaveBeenCalledTimes(1)
})
