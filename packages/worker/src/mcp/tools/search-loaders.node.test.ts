import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as Authorize from '#worker/authorization/authorize.ts'

const mocks = vi.hoisted(() => ({
	listPackages: vi.fn(),
	buildRows: vi.fn(),
	getRegistry: vi.fn(),
	listSecrets: vi.fn(),
	listIntegrations: vi.fn(),
	listServerRefs: vi.fn(),
	access: null as Authorize.EffectivePermissions | null,
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof Authorize>()
	return {
		...actual,
		computeEffectivePermissions: (
			input: Parameters<typeof actual.computeEffectivePermissions>[0],
		) =>
			mocks.access
				? Promise.resolve(mocks.access)
				: actual.computeEffectivePermissions(input),
		runWithRequestPermissions: <T>(
			ctx: Parameters<typeof actual.runWithRequestPermissions>[0],
			run: () => Promise<T>,
		) => (mocks.access ? run() : actual.runWithRequestPermissions(ctx, run)),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesWithCommunityProvenanceByUserId: (...args: Array<unknown>) =>
		mocks.listPackages(...args),
}))
vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async (input: {
		records: Array<unknown>
	}) => input.records,
}))
vi.mock('./search-package-rows.ts', () => ({
	buildSavedPackageSearchRows: (...args: Array<unknown>) =>
		mocks.buildRows(...args),
}))
vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mocks.getRegistry(...args),
}))
vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (...args: Array<unknown>) =>
		mocks.listSecrets(...args),
}))
vi.mock('#worker/integrations/service.ts', () => ({
	listJoinedIntegrations: (...args: Array<unknown>) =>
		mocks.listIntegrations(...args),
}))
vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listVisibleEnabledMcpServerRefsCached: (...args: Array<unknown>) =>
		mocks.listServerRefs(...args),
}))

const { loadSearchRowsAndRegistry } = await import('./search-loaders.ts')

const env = { APP_DB: {} } as Env

function savedPackage(id: string, userId: string) {
	return {
		id,
		userId,
		name: `@acme/${id}`,
		kodyId: id,
		hidden: false,
	}
}

beforeEach(() => {
	mocks.access = null
	for (const mock of [
		mocks.listPackages,
		mocks.buildRows,
		mocks.getRegistry,
		mocks.listSecrets,
		mocks.listIntegrations,
		mocks.listServerRefs,
	]) {
		mock.mockReset()
	}
	mocks.getRegistry.mockResolvedValue({ capabilities: [], mcpServers: [] })
	mocks.listSecrets.mockResolvedValue([])
	mocks.listIntegrations.mockResolvedValue([])
	mocks.listServerRefs.mockResolvedValue([])
	mocks.buildRows.mockImplementation(
		async (input: { records: Array<{ id: string }> }) => ({
			rows: input.records.map((record) => ({ record })),
			warnings: [],
		}),
	)
	mocks.listPackages.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === 'org-1'
				? [savedPackage('org-pkg', 'org-1')]
				: [savedPackage('person-pkg', 'user-1')],
	)
})

function orgBoundCallerContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'a@example.com',
			displayName: 'A',
		},
		orgBinding: {
			org: { id: ownerIdFromStored('org-1'), slug: 'acme' },
			role: 'owner',
		},
	})
}

test('org-bound discovery lists the bound org packages, not the acting person packages', async () => {
	const callerContext = orgBoundCallerContext()
	expect(callerContext.request?.org.id).toBe('org-1')

	const result = await loadSearchRowsAndRegistry({
		env,
		callerContext,
		userId: ownerIdFromStored('user-1'),
	})

	expect(mocks.listPackages).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('org-1'),
	})
	expect(mocks.buildRows).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('org-1') }),
	)
	expect(result.packageRows.map((row) => row.record.id)).toEqual(['org-pkg'])
})

test('a personal connection still lists the person own packages', async () => {
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'a@example.com',
			displayName: 'A',
		},
	})
	const result = await loadSearchRowsAndRegistry({
		env,
		callerContext,
		userId: ownerIdFromStored('user-1'),
	})
	expect(mocks.listPackages).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
	})
	expect(result.packageRows.map((row) => row.record.id)).toEqual(['person-pkg'])
})

test('a grant-only collaborator sees only granted secrets and integrations', async () => {
	mocks.access = {
		orgId: ownerIdFromStored('org-1'),
		isOwner: false,
		permissions: new Set<OrgPermission>(['search:read']),
		resourcePermissions: new Map<string, ReadonlySet<OrgPermission>>([
			['credential:cred-granted-secret', new Set(['secret:use'])],
			['credential:cred-github', new Set(['integration:use'])],
		]),
		credentialScopes: null,
	}
	mocks.listSecrets.mockResolvedValue([
		{ name: 'granted-secret', credentialId: 'cred-granted-secret' },
		{ name: 'other-secret', credentialId: 'cred-other-secret' },
	])
	mocks.listIntegrations.mockResolvedValue([
		{ connection: { name: 'github', credentialId: 'cred-github' } },
		{ connection: { name: 'linear', credentialId: 'cred-linear' } },
	])
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example',
		user: {
			userId: personIdFromStored('guest-1'),
			email: 'guest@example.com',
			displayName: 'Guest',
		},
		orgBinding: {
			org: { id: ownerIdFromStored('org-1'), slug: 'acme' },
			role: null,
		},
	})
	const result = await loadSearchRowsAndRegistry({
		env,
		callerContext,
		userId: ownerIdFromStored('org-1'),
	})
	expect(result.userSecretRows.map((row) => row.name)).toEqual([
		'granted-secret',
	])
	expect(result.userIntegrationRows.map((row) => row.connection.name)).toEqual([
		'github',
	])
})
