import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	adoptCommunityFork: vi.fn(),
	reloadAccountPackagesAfterWrite: vi.fn(),
	savedPackage: {
		id: 'pkg-1',
		userId: 'stable-user-1',
		name: '@user/pkg',
		kodyId: 'pkg',
	},
	viewerIsOrgOwner: true,
}))

vi.mock('#worker/community/service.ts', () => ({
	adoptCommunityFork: (...args: Array<unknown>) =>
		mockModule.adoptCommunityFork(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	reloadAccountPackagesAfterWrite: (...args: Array<unknown>) =>
		mockModule.reloadAccountPackagesAfterWrite(...args),
}))

vi.mock('#app/package-viewer-access.ts', () => ({
	viewerIsSavedPackageOrgOwner: vi.fn(async () => mockModule.viewerIsOrgOwner),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: vi.fn(async () => mockModule.savedPackage),
}))

const { adoptAccountPackageFork } = await import('./account-package-adopt.ts')

function createUser() {
	const actor = personIdFromStored('stable-user-1')
	return {
		sessionUserId: '42',
		userId: 42,
		username: 'user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: [],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: actor,
			email: 'user@example.com',
			username: 'user',
			displayName: 'user',
		},
		request: sessionRequestContext(actor),
	}
}

test('the signed-in owner adopts a community fork from the account API', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.adoptCommunityFork.mockResolvedValue({ alreadyAdopted: false })
	mockModule.reloadAccountPackagesAfterWrite.mockRejectedValue(
		new Error('Page read unavailable'),
	)

	const response = await adoptAccountPackageFork({
		env,
		request,
		user,
		packageId: 'pkg-1',
		reviewNote: '  Read src/ and package.json; no exfiltration.  ',
	})
	expect(response?.status).toBe(200)
	expect(response?.data).toEqual({
		ok: true,
		packageId: 'pkg-1',
	})
	expect(mockModule.adoptCommunityFork).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('stable-user-1'),
		packageId: 'pkg-1',
		reviewSummary: 'Read src/ and package.json; no exfiltration.',
	})
	expect(mockModule.reloadAccountPackagesAfterWrite).not.toHaveBeenCalled()
})

test('account adopt requires org owner role on the package owning org', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.viewerIsOrgOwner = false
	const denied = await adoptAccountPackageFork({
		env,
		request,
		user,
		packageId: 'pkg-1',
		reviewNote: 'Reviewed source and trust this fork.',
	})
	expect(denied?.status).toBe(404)
	expect(mockModule.adoptCommunityFork).not.toHaveBeenCalled()
	mockModule.viewerIsOrgOwner = true
})

test('account adopt requires a package id and surfaces caller-clearable errors', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})

	const missingId = await adoptAccountPackageFork({
		env,
		request,
		user,
		packageId: '',
		reviewNote: 'Reviewed it all.',
	})
	expect(missingId?.status).toBe(400)
	expect(mockModule.adoptCommunityFork).not.toHaveBeenCalled()

	mockModule.adoptCommunityFork.mockRejectedValueOnce(
		new CommunityActionError('Adoption requires a review note of at least 10'),
	)
	const shortNote = await adoptAccountPackageFork({
		env,
		request,
		user,
		packageId: 'pkg-1',
		reviewNote: 'short',
	})
	expect(shortNote?.status).toBe(400)
	expect(shortNote?.data).toEqual({
		ok: false,
		error: 'Adoption requires a review note of at least 10',
	})
	expect(mockModule.reloadAccountPackagesAfterWrite).not.toHaveBeenCalled()
})
