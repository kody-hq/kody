import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { type PackageAppServeOwner } from './package-app-serve.ts'
import { packageAppRuntimeForwardUnavailableMessage } from '#worker/runtime-worker-service.ts'
import type * as RuntimeWorkerServiceModule from '#worker/runtime-worker-service.ts'

const runtimeForwardMock = vi.hoisted(() => ({
	hasLocalPackageAppRuntimeBridge: vi.fn(() => true),
	getRuntimeWorkerService: vi.fn<
		typeof RuntimeWorkerServiceModule.getRuntimeWorkerService
	>(() => null),
	servePackageApp: vi.fn(),
	buildPackageAppWorker: vi.fn(),
	resolveSavedPackageForPackageAppSlug: vi.fn(),
	createPackageAppCallerContext: vi.fn(),
}))

vi.mock('#worker/runtime-worker-service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RuntimeWorkerServiceModule>()
	return {
		...actual,
		hasLocalPackageAppRuntimeBridge: () =>
			runtimeForwardMock.hasLocalPackageAppRuntimeBridge(),
		getRuntimeWorkerService: (
			...args: Parameters<
				typeof RuntimeWorkerServiceModule.getRuntimeWorkerService
			>
		) => runtimeForwardMock.getRuntimeWorkerService(...args),
	}
})

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackageForPackageAppSlug: (...args: Array<unknown>) =>
		runtimeForwardMock.resolveSavedPackageForPackageAppSlug(...args),
	loadInvokeManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-app.ts', () => ({
	buildPackageAppWorker: (...args: Array<unknown>) =>
		runtimeForwardMock.buildPackageAppWorker(...args),
	createPackageAppCallerContext: (...args: Array<unknown>) =>
		runtimeForwardMock.createPackageAppCallerContext(...args),
}))

const { servePackageAppRequest } = await import('./package-app-serve.ts')

const owner: PackageAppServeOwner = {
	userId: ownerIdFromStored('user-1'),
	username: 'demo',
	email: 'demo@example.com',
	displayName: 'Demo',
}

const visitor = {
	userId: personIdFromStored('user-1'),
	username: 'demo',
	role: 'owner',
} as const

function createServeInput(env: Env = {} as Env) {
	return {
		request: new Request('https://example.com/@demo/packages/hello/'),
		env,
		owner,
		visitor,
		packagePath: {
			username: 'demo',
			kodyId: 'hello',
			restPath: '/',
			mount: 'username-path' as const,
		},
		dispatch: { synthetic: true } as const,
	}
}

test('servePackageAppRequest forwards to RUNTIME_WORKER when PackageAppRuntimeBridge is missing', async () => {
	runtimeForwardMock.hasLocalPackageAppRuntimeBridge.mockReturnValue(false)
	const forwarded = new Response('from-runtime', { status: 200 })
	runtimeForwardMock.servePackageApp.mockResolvedValue(forwarded)
	runtimeForwardMock.getRuntimeWorkerService.mockReturnValue({
		fetch: vi.fn(),
		servePackageApp: runtimeForwardMock.servePackageApp,
	})

	const input = createServeInput({ RUNTIME_WORKER: {} } as Env)
	const response = await servePackageAppRequest(input)

	expect(response).toBe(forwarded)
	expect(runtimeForwardMock.servePackageApp).toHaveBeenCalledWith({
		request: input.request,
		owner: input.owner,
		visitor: input.visitor,
		packagePath: input.packagePath,
		dispatch: input.dispatch,
		identity: null,
		consentPrincipal: null,
	})
	expect(runtimeForwardMock.buildPackageAppWorker).not.toHaveBeenCalled()
	expect(
		runtimeForwardMock.resolveSavedPackageForPackageAppSlug,
	).not.toHaveBeenCalled()
})

test('servePackageAppRequest stays local when PackageAppRuntimeBridge is available', async () => {
	runtimeForwardMock.hasLocalPackageAppRuntimeBridge.mockReturnValue(true)
	runtimeForwardMock.getRuntimeWorkerService.mockReturnValue({
		fetch: vi.fn(),
		servePackageApp: runtimeForwardMock.servePackageApp,
	})
	runtimeForwardMock.resolveSavedPackageForPackageAppSlug.mockResolvedValue(
		null,
	)

	const response = await servePackageAppRequest(
		createServeInput({ RUNTIME_WORKER: {} } as Env),
	)

	expect(response.status).toBe(404)
	expect(runtimeForwardMock.servePackageApp).not.toHaveBeenCalled()
	expect(
		runtimeForwardMock.resolveSavedPackageForPackageAppSlug,
	).toHaveBeenCalled()
})

test('servePackageAppRequest fails closed when PackageAppRuntimeBridge and RUNTIME_WORKER are both missing', async () => {
	consoleError.mockImplementation(() => {})
	runtimeForwardMock.hasLocalPackageAppRuntimeBridge.mockReturnValue(false)
	runtimeForwardMock.getRuntimeWorkerService.mockReturnValue(null)

	const response = await servePackageAppRequest(createServeInput({} as Env))

	expect(response.status).toBe(500)
	const body = (await response.json()) as { cause?: string }
	expect(body.cause).toBe(packageAppRuntimeForwardUnavailableMessage)
	expect(consoleError).toHaveBeenCalledWith(
		'package-app-http-error',
		expect.objectContaining({
			status: 500,
			phase: 'host-setup',
			runtimeRunId: null,
			pathname: '/@demo/packages/hello/',
		}),
	)
	expect(runtimeForwardMock.servePackageApp).not.toHaveBeenCalled()
	expect(
		runtimeForwardMock.resolveSavedPackageForPackageAppSlug,
	).not.toHaveBeenCalled()
	expect(runtimeForwardMock.buildPackageAppWorker).not.toHaveBeenCalled()
})
