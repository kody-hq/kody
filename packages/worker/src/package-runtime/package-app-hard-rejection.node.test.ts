import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { PackageAppRuntimeBridge } from './package-app.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import type * as PackageAppAuthorityRejections from './package-app-authority-rejections.ts'

const scheduled = vi.hoisted(() => ({
	rejections: [] as Array<Record<string, unknown>>,
}))

vi.mock('./package-app-authority.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthority>()),
	loadPackageAppRunsAs: async () => ({ status: 'ready' }),
}))

vi.mock('./package-app-authority-rejections.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthorityRejections>()),
	schedulePackageAppAuthorityRejection: (input: {
		event: Record<string, unknown>
	}) => {
		scheduled.rejections.push(input.event)
	},
}))

const { PackageAppCapabilityNotDeclaredError } =
	await import('./package-app-authority-rejections.ts')

type RunWithAuthority = (input: {
	callName: string
	storageId: string | null
	visitTicket: string | null | undefined
	run: (callerContext: unknown) => Promise<unknown>
}) => Promise<unknown>

function createBridge() {
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

test('an undeclared capability fails and records one hard rejection', async () => {
	const runWithAuthority = createBridge()
	await expect(
		runWithAuthority({
			callName: 'secretList',
			storageId: null,
			visitTicket: null,
			run: async () => {
				throw new PackageAppCapabilityNotDeclaredError('secretList')
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
})

test('credential.named refused as runs-as records a hard rejection', async () => {
	const runWithAuthority = createBridge()
	await expect(
		runWithAuthority({
			callName: 'credential:credentialClientOpen',
			storageId: null,
			visitTicket: null,
			run: async () => {
				throw new PackageAppCapabilityNotDeclaredError('credential.named')
			},
		}),
	).rejects.toThrow(/credential\.named/)
	expect(scheduled.rejections).toEqual([
		expect.objectContaining({
			callName: 'credential:credentialClientOpen',
			kind: 'capability_not_declared',
		}),
	])
})

test('a refusal that is not about declaration fails without a hard rejection, and nothing retries as the visitor', async () => {
	const runWithAuthority = createBridge()
	const denied = new AuthorizationError({
		code: 'missing_permission',
		permission: 'secret:read',
		orgId: null,
		resource: null,
		message: 'no',
	})
	const run = vi.fn(async () => {
		throw denied
	})
	await expect(
		runWithAuthority({
			callName: 'secretList',
			storageId: null,
			visitTicket: null,
			run,
		}),
	).rejects.toBe(denied)
	expect(run).toHaveBeenCalledTimes(1)
	expect(scheduled.rejections).toEqual([])
})
