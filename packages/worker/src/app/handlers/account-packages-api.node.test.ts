import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
	user: null as null | { mcpUser: { userId: string } },
	auth: { user: null as null | { accountDeleting?: boolean } },
	leaseWrite: vi.fn(async (write: () => Promise<Response>) => write()),
	lock: vi.fn(async () => ({
		data: { ok: true, packageId: 'pkg-1' },
		status: 200,
	})),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: async () => state.user,
}))
vi.mock('#app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: async () => state.auth,
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: async (input: { write: () => Promise<Response> }) =>
		state.leaseWrite(input.write),
}))
vi.mock('#worker/orgs/personal-org-id.ts', () => ({
	personalOrgIdForPerson: () => 'stable-user-1',
}))
vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackagesData: async () => ({ ok: true, packages: [] }),
}))
vi.mock('#app/account-package-publish-lock.ts', () => ({
	lockAccountPackage: state.lock,
	unlockAccountPackage: vi.fn(),
	approveAccountPackagePublish: vi.fn(),
}))
vi.mock('#app/account-package-visibility.ts', () => ({
	setAccountPackageVisibility: vi.fn(),
}))
vi.mock('#app/account-package-capability-approval.ts', () => ({
	setAccountPackageInternetVisible: vi.fn(),
	approveAccountPackageCapabilities: vi.fn(),
	approveAccountPackageCapabilitiesAndGoPublic: vi.fn(),
	approveAccountPackageCredentialNeeds: vi.fn(),
	approveAccountPackageWentPublic: vi.fn(),
}))
vi.mock('#app/account-package-delete.ts', () => ({
	deleteAccountPackage: vi.fn(),
}))
vi.mock('#app/account-package-adopt.ts', () => ({
	adoptAccountPackageFork: vi.fn(),
}))
vi.mock('#app/account-package-write-access.ts', () => ({
	loadWritableAccountSavedPackage: vi.fn(),
}))
vi.mock('#worker/community/service.ts', () => ({
	absorbCommunityForkUpstream: vi.fn(),
}))

const { createAccountPackagesApiHandler } =
	await import('./account-packages.ts')

test('unauthenticated POST /account/packages.json returns JSON 401', async () => {
	state.user = null
	const handler = createAccountPackagesApiHandler({} as Env)
	const response = await handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		}),
	})
	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
})

test('authenticated lock action reaches the typed package operation', async () => {
	state.user = { mcpUser: { userId: 'person-1' } }
	state.auth = { user: { accountDeleting: false } }
	state.lock.mockClear()
	const handler = createAccountPackagesApiHandler({ APP_DB: {} } as Env)
	const response = await handler({
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'lock', packageId: 'pkg-1' }),
		}),
	})
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		packageId: 'pkg-1',
	})
	expect(state.lock).toHaveBeenCalledWith(
		expect.objectContaining({ packageId: 'pkg-1' }),
	)
})
