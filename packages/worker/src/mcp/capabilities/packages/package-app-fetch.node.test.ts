import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AppBaseUrl from '#worker/app-base-url.ts'
import { invalidateInvokeContractFreshness } from '#worker/package-invocations/invoke-contract-cache.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	servePackageAppRequest: vi.fn(),
	findPlainRepoPromotionHint: vi.fn(),
	getPackageAppBaseUrl: vi.fn<typeof AppBaseUrl.getPackageAppBaseUrl>(
		() => 'https://apps.example.com',
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	findPlainRepoPromotionHint: (...args: Array<unknown>) =>
		mockModule.findPlainRepoPromotionHint(...args),
	buildPlainRepoPromotionErrorMessage: (lookup: string) =>
		`Promote plain repo before package lookup (${lookup}).`,
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getPackageAppBaseUrl: (
		...args: Parameters<typeof AppBaseUrl.getPackageAppBaseUrl>
	) => mockModule.getPackageAppBaseUrl(...args),
}))

vi.mock('#worker/package-runtime/package-app-serve.ts', () => ({
	servePackageAppRequest: (...args: Array<unknown>) =>
		mockModule.servePackageAppRequest(...args),
}))

const { packageAppFetchCapability } = await import('./package-app-fetch.ts')

type ContextInput = {
	packageId?: string
	executionOrigin?: 'interactive' | 'background'
	orgBinding?: {
		org: { id: string; slug: string }
		role: 'owner' | 'member' | 'billing' | null
	}
}

function fetchApp(args: Record<string, unknown>, input: ContextInput = {}) {
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: ownerIdFromStored('user-1'),
		ownerScope: 'kody',
		ownerEmail: 'kody@example.com',
		actorUserId: 'user-1',
	})
	return packageAppFetchCapability.handler(args, {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: input.executionOrigin ?? 'interactive',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'kody@example.com',
				displayName: 'Kody',
				username: 'kody',
			},
			storageContext: input.packageId
				? {
						sessionId: null,
						appId: null,
						packageId: input.packageId,
						storageId: null,
					}
				: null,
			orgBinding: input.orgBinding,
		}),
	})
}

function savedPackage(overrides?: { hasApp?: boolean }) {
	return {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@kody/demo-app',
		kodyId: 'demo-app',
		description: 'Demo app',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: overrides?.hasApp ?? true,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-08-08T00:00:00.000Z',
		updatedAt: '2026-08-08T00:00:00.000Z',
	}
}

function invalidateDemoPackageCache() {
	invalidateInvokeContractFreshness({
		userId: ownerIdFromStored('user-1'),
		packageIdOrKodyIds: ['package-1', 'demo-app', '@kody/demo-app'],
	})
}

const lastServedRequest = () =>
	mockModule.servePackageAppRequest.mock.calls.at(-1)?.[0]?.request as Request

test('packageAppFetch dispatches synthetic in-process app requests against hosted URLs', async () => {
	invalidateDemoPackageCache()
	mockModule.resolveSavedPackageRef.mockResolvedValue(savedPackage())
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'content-length': '999',
			},
		}),
	)

	const result = await fetchApp({
		kody_id: 'demo-app',
		path: '/api/health',
		method: 'GET',
		headers: {
			Host: 'forged.example.com',
			'CF-Ray': 'forged',
			'X-Forwarded-For': '127.0.0.1',
			Origin: 'https://caller.example.com',
			'X-Test': 'kept',
		},
	})

	expect(result).toEqual({
		status: 200,
		headers: { 'content-type': 'application/json' },
		body: '{"ok":true}',
		truncated: false,
	})
	expect(mockModule.servePackageAppRequest).toHaveBeenCalledWith(
		expect.objectContaining({
			dispatch: { synthetic: true },
			owner: expect.objectContaining({
				userId: ownerIdFromStored('user-1'),
				username: 'kody',
			}),
			packagePath: {
				username: 'kody',
				kodyId: 'demo-app',
				restPath: '/api/health',
				mount: 'user-subdomain',
			},
		}),
	)
	const request = lastServedRequest()
	expect(request).toBeInstanceOf(Request)
	expect(request.url).toBe('https://kody.apps.example.com/demo-app/api/health')
	expect(
		Object.fromEntries(
			['Host', 'CF-Ray', 'X-Forwarded-For', 'Origin', 'X-Test', 'Accept'].map(
				(name) => [name, request.headers.get(name)],
			),
		),
	).toEqual({
		Host: null,
		'CF-Ray': null,
		'X-Forwarded-For': null,
		Origin: 'https://caller.example.com',
		'X-Test': 'kept',
		Accept: 'application/json',
	})

	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response('ok', { status: 200 }),
	)
	await fetchApp({ kody_id: 'demo-app', headers: { Accept: 'text/html' } })
	expect(lastServedRequest().headers.get('Accept')).toBe('text/html')
})

test('packageAppFetch serves a team org app as the calling person, with their role there', async () => {
	invalidateDemoPackageCache()
	mockModule.resolveSavedPackageRef.mockResolvedValue(savedPackage())
	mockModule.servePackageAppRequest.mockResolvedValue(new Response('ok'))

	await fetchApp(
		{ kody_id: 'demo-app' },
		{ orgBinding: { org: { id: 'org-team', slug: 'team' }, role: 'owner' } },
	)

	expect(mockModule.servePackageAppRequest).toHaveBeenCalledWith(
		expect.objectContaining({
			visitor: {
				userId: personIdFromStored('user-1'),
				username: 'kody',
				role: 'owner',
			},
		}),
	)
})

test('packageAppFetch resolves owned packages by package_id', async () => {
	invalidateDemoPackageCache()
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage())
	mockModule.servePackageAppRequest.mockResolvedValue(
		new Response('ok', { status: 200 }),
	)

	expect(await fetchApp({ package_id: 'package-1' })).toEqual({
		status: 200,
		headers: { 'content-type': 'text/plain;charset=UTF-8' },
		body: 'ok',
		truncated: false,
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		{},
		{ userId: ownerIdFromStored('user-1'), packageId: 'package-1' },
	)
	expect(mockModule.resolveSavedPackageRef).not.toHaveBeenCalled()
})

test('packageAppFetch rejects invalid callers, paths, and missing packages', async () => {
	invalidateDemoPackageCache()
	const exactlyOne =
		'Provide exactly one of `package_id` or the package name leaf.'
	const runtimeOnly =
		'packageAppFetch is unavailable from package runtime contexts.'
	const demo = { kody_id: 'demo-app' }
	for (const [args, input, message] of [
		[{}, {}, exactlyOne],
		[{ package_id: 'package-1', ...demo }, {}, exactlyOne],
		[demo, { packageId: 'package-1' }, runtimeOnly],
		[demo, { executionOrigin: 'background' }, runtimeOnly],
		[
			{ ...demo, headers: { Upgrade: 'websocket' } },
			{},
			'packageAppFetch does not support websocket Upgrade requests.',
		],
		[
			{ ...demo, path: '/../other-package/probe' },
			{},
			'packageAppFetch path must not contain parent traversal segments.',
		],
		[
			{ ...demo, method: 'POST', body: 'x'.repeat(102_401) },
			{},
			'request body exceeds 102400 bytes',
		],
	] as Array<[Record<string, unknown>, ContextInput, string]>) {
		mockModule.resolveSavedPackageRef.mockResolvedValue(savedPackage())
		await expect(fetchApp(args, input)).rejects.toThrow(message)
	}
	expect(mockModule.servePackageAppRequest).not.toHaveBeenCalled()

	mockModule.resolveSavedPackageRef.mockClear()
	await expect(fetchApp({ kody_id: '@other/demo-app' })).rejects.toThrow(
		'does not match the acting owner "@kody"',
	)
	expect(mockModule.resolveSavedPackageRef).not.toHaveBeenCalled()

	mockModule.resolveSavedPackageRef.mockResolvedValue(null)
	mockModule.findPlainRepoPromotionHint.mockResolvedValue(null)
	await expect(fetchApp({ kody_id: 'missing' })).rejects.toThrow(
		'Saved package not found for this user.',
	)

	mockModule.findPlainRepoPromotionHint.mockResolvedValue({ id: 'repo-1' })
	await expect(fetchApp({ kody_id: 'missing' })).rejects.toThrow(
		'Promote plain repo before package lookup',
	)

	// Drop the hasApp-true entry warmed by earlier cases in this test before
	// asserting the no-app path.
	invalidateDemoPackageCache()
	mockModule.resolveSavedPackageRef.mockResolvedValue(
		savedPackage({ hasApp: false }),
	)
	await expect(fetchApp(demo)).rejects.toThrow('has no declared app')
})

test('packageAppFetch truncates oversized bodies and encodes binary as base64', async () => {
	invalidateDemoPackageCache()
	mockModule.resolveSavedPackageRef.mockResolvedValue(savedPackage())
	const respondWith = (
		body: string | Uint8Array<ArrayBuffer>,
		contentType: string,
	) =>
		mockModule.servePackageAppRequest.mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { 'content-type': contentType },
			}),
		)

	respondWith('x'.repeat(102_401), 'text/plain')
	expect(await fetchApp({ kody_id: 'demo-app' })).toEqual({
		status: 200,
		headers: { 'content-type': 'text/plain' },
		body: 'x'.repeat(102_400),
		truncated: true,
	})

	const binary = new TextEncoder().encode('valid utf-8 binary bytes')
	respondWith(binary, 'application/octet-stream')
	expect(await fetchApp({ kody_id: 'demo-app' })).toEqual({
		status: 200,
		headers: { 'content-type': 'application/octet-stream' },
		body: bytesToBase64(binary),
		truncated: false,
	})

	const largeBinary = new TextEncoder().encode('b'.repeat(102_400))
	respondWith(largeBinary, 'application/octet-stream')
	const capped = await fetchApp({ kody_id: 'demo-app' })
	const decoded = base64ToBytes(capped.body)
	expect(decoded).toEqual(largeBinary.slice(0, decoded.byteLength))
	expect(capped.body.length).toBeLessThanOrEqual(102_400)
	expect(capped.truncated).toBe(true)
})
