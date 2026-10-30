import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { PackageAppRuntimeBridge } from './package-app.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import type * as PackageAppAuthorityFallback from './package-app-authority-fallback.ts'

const scheduled = vi.hoisted(() => ({
	fallbacks: [] as Array<Record<string, unknown>>,
	rejections: [] as Array<Record<string, unknown>>,
}))

vi.mock('./package-app-authority.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthority>()),
	loadPackageAppRunsAs: async () => ({ status: 'ready' }),
}))

vi.mock('./package-app-authority-fallback.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthorityFallback>()),
	schedulePackageAppAuthorityFallback: (input: {
		event: Record<string, unknown>
	}) => {
		scheduled.fallbacks.push(input.event)
	},
	schedulePackageAppAuthorityRejection: (input: {
		event: Record<string, unknown>
	}) => {
		scheduled.rejections.push(input.event)
	},
}))

const { PackageAppCapabilityNotDeclaredError } =
	await import('./package-app-authority-fallback.ts')

type RunWithAuthority = (input: {
	callName: string
	storageId: string | null
	visitTicket: string | null | undefined
	run: (callerContext: unknown, mode: 'runs-as' | 'legacy') => Promise<unknown>
	refusedResultKind?: (result: unknown) => string | null
}) => Promise<unknown>

function createBridge() {
	scheduled.fallbacks.length = 0
	scheduled.rejections.length = 0
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('org-a'),
				orgSlug: 'org-a',
				visitor: null,
				packageId: 'pkg-example-app',
				kodyId: 'app',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: ['pkg-example-app'],
				credentialClientBinding: 'run:test',
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
				declaredCapabilities: [],
			},
			waitUntil() {},
		} as never,
		{} as Env,
	)
	const internals = bridge as unknown as {
		runWithAuthority: RunWithAuthority
		createRunsAsCallerContext: () => unknown
		createCallerContext: () => Promise<unknown>
	}
	vi.spyOn(internals, 'createRunsAsCallerContext').mockReturnValue({})
	vi.spyOn(internals, 'createCallerContext').mockResolvedValue({})
	return (input: Parameters<RunWithAuthority>[0]) =>
		internals.runWithAuthority.call(bridge, input)
}

const refusedResult = { ok: false, error: { code: 'credential_not_found' } }
const refusedResultKind = (result: unknown) =>
	(result as { ok?: boolean }).ok === false ? 'credential_unavailable' : null

test('an undeclared capability that also fails the legacy way records one hard rejection', async () => {
	const runWithAuthority = createBridge()
	await expect(
		runWithAuthority({
			callName: 'secretList',
			storageId: null,
			visitTicket: null,
			run: async (_context, mode) => {
				if (mode === 'runs-as') {
					throw new PackageAppCapabilityNotDeclaredError('secretList')
				}
				throw new Error('Authenticated MCP user is required')
			},
		}),
	).rejects.toBeInstanceOf(PackageAppCapabilityNotDeclaredError)
	expect(scheduled.rejections).toEqual([
		{
			ownerId: ownerIdFromStored('org-a'),
			packageId: 'pkg-example-app',
			callName: 'secretList',
			kind: 'capability_not_declared',
			visitorId: null,
		},
	])
	expect(scheduled.fallbacks).toEqual([])
})

test('credential.named refused as runs-as and refused the legacy way records a hard rejection', async () => {
	const runWithAuthority = createBridge()
	await expect(
		runWithAuthority({
			callName: 'credential:credentialClientOpen',
			storageId: null,
			visitTicket: null,
			refusedResultKind,
			run: async (_context, mode) => {
				if (mode === 'runs-as') {
					throw new PackageAppCapabilityNotDeclaredError('credential.named')
				}
				return refusedResult
			},
		}),
	).rejects.toThrow(/credential\.named/)
	expect(scheduled.rejections).toEqual([
		expect.objectContaining({
			callName: 'credential:credentialClientOpen',
			kind: 'capability_not_declared',
		}),
	])
	expect(scheduled.fallbacks).toEqual([])
})

test('a call the legacy way rescues is a fallback, not a hard rejection', async () => {
	const runWithAuthority = createBridge()
	await expect(
		runWithAuthority({
			callName: 'secretList',
			storageId: null,
			visitTicket: null,
			run: async (_context, mode) => {
				if (mode === 'runs-as') {
					throw new PackageAppCapabilityNotDeclaredError('secretList')
				}
				return { secrets: [] }
			},
		}),
	).resolves.toEqual({ secrets: [] })
	expect(scheduled.fallbacks).toEqual([
		expect.objectContaining({
			callName: 'secretList',
			kind: 'capability_not_declared',
		}),
	])
	expect(scheduled.rejections).toEqual([])
})

test('a refusal that is not about declaration is never counted as a hard rejection', async () => {
	const runWithAuthority = createBridge()
	const denied = new AuthorizationError({
		code: 'missing_permission',
		permission: 'secret:read',
		orgId: null,
		resource: null,
		message: 'no',
	})
	await expect(
		runWithAuthority({
			callName: 'secretList',
			storageId: null,
			visitTicket: null,
			run: async (_context, mode) => {
				if (mode === 'runs-as') throw denied
				throw new Error('also denied')
			},
		}),
	).rejects.toBe(denied)
	expect(scheduled.rejections).toEqual([])
	expect(scheduled.fallbacks).toEqual([])
})
