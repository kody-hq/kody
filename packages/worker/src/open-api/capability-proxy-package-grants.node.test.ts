import { afterEach, expect, test, vi } from 'vitest'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'

const mocks = vi.hoisted(() => ({
	verifyLocalExecutePackageBinding: vi.fn(
		async ({ token }: { token: unknown }) => String(token),
	),
	getSavedPackageById: vi.fn(
		async (_db: unknown, { packageId }: { packageId: string }) => ({
			id: packageId,
			name: packageId,
			kodyId: packageId,
		}),
	),
	authorize: vi.fn(async () => {}),
}))

vi.mock(
	'#worker/package-runtime/local-execute-package-binding.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		verifyLocalExecutePackageBinding: mocks.verifyLocalExecutePackageBinding,
	}),
)
vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getSavedPackageById: mocks.getSavedPackageById,
}))
vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	authorize: mocks.authorize,
}))

const { authorizeLocalExecutePackageBinding } =
	await import('./capability-proxy-package-grants.ts')
const { executionContextRunAccessReuseMs } =
	await import('./execution-context-run-access.ts')

let runCounter = 0

function makeRequest(
	credential: Partial<RequestContext['credential']> = {},
): RequestContext {
	runCounter += 1
	return {
		org: { id: 'org_1' },
		actor: { userId: 'person_1' },
		attribution: {},
		credential: {
			kind: 'execution-context-run',
			id: `run_${runCounter}`,
			orgId: 'org_1',
			scopes: null,
			...credential,
		},
		membership: { role: 'member' },
	} as unknown as RequestContext
}

function authorizeBinding(request: RequestContext, packageBinding = 'pkg_1') {
	return authorizeLocalExecutePackageBinding({
		db: {} as D1Database,
		env: {} as Env,
		request,
		orgUserId: 'org_1',
		packageBinding,
	})
}

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

test('a burst from one run checks package:execute once', async () => {
	const request = makeRequest()
	const results = await Promise.all(
		Array.from({ length: 10 }, () => authorizeBinding(request)),
	)
	expect(results).toEqual(Array(10).fill('pkg_1'))
	expect(mocks.verifyLocalExecutePackageBinding).toHaveBeenCalledTimes(10)
	expect(mocks.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(mocks.authorize).toHaveBeenCalledTimes(1)
})

test('other callers never reuse a run grant', async () => {
	const request = makeRequest()
	await authorizeBinding(request)
	await authorizeBinding(request, 'pkg_2')
	await authorizeBinding({ ...request, actor: { userId: 'person_2' } } as never)
	await authorizeBinding({ ...request, org: { id: 'org_2' } } as never)
	await authorizeBinding({
		...request,
		credential: { ...request.credential, scopes: ['package:read'] },
	} as never)
	await authorizeBinding({
		...request,
		credential: { ...request.credential, profileId: 'profile_2' },
	} as never)
	await authorizeBinding(makeRequest())
	expect(mocks.authorize).toHaveBeenCalledTimes(7)
})

test('callers outside an execution-context run check every call', async () => {
	const request = makeRequest({ kind: 'api-token', id: 'token_1' })
	await authorizeBinding(request)
	await authorizeBinding(request)
	expect(mocks.authorize).toHaveBeenCalledTimes(2)
})

test('a denial is never reused', async () => {
	const request = makeRequest()
	mocks.authorize.mockRejectedValueOnce(new Error('denied'))
	await expect(authorizeBinding(request)).rejects.toThrow('denied')
	await expect(authorizeBinding(request)).resolves.toBe('pkg_1')
	expect(mocks.authorize).toHaveBeenCalledTimes(2)
})

test('a revoked grant is honored once the reuse window passes', async () => {
	vi.useFakeTimers()
	const request = makeRequest()
	await authorizeBinding(request)
	mocks.authorize.mockRejectedValue(new Error('revoked'))
	vi.advanceTimersByTime(executionContextRunAccessReuseMs - 1)
	await expect(authorizeBinding(request)).resolves.toBe('pkg_1')
	vi.advanceTimersByTime(1)
	await expect(authorizeBinding(request)).rejects.toThrow('revoked')
	mocks.authorize.mockReset()
})
