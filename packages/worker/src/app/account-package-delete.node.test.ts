import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	writablePackage: null as ReturnType<typeof createSavedPackage> | null,
	deleteSavedPackageProjection: vi.fn(),
}))

vi.mock('#app/account-package-write-access.ts', () => ({
	loadWritableAccountSavedPackage: vi.fn(
		async (input: { user: { mcpUser: { userId: string } } }) => {
			if (!mockModule.writablePackage) {
				return {
					ok: false as const,
					response: new Response(
						JSON.stringify({ ok: false, error: 'Package not found.' }),
						{ status: 404 },
					),
				}
			}
			return {
				ok: true as const,
				package: {
					savedPackage: mockModule.writablePackage,
					ownerUserId: mockModule.writablePackage.userId,
					actorUserId: input.user.mcpUser.userId,
				},
			}
		},
	),
}))

vi.mock('#worker/package-registry/service.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		deleteSavedPackageProjection: (...args: Array<unknown>) =>
			mockModule.deleteSavedPackageProjection(...args),
	}
})

const { deleteAccountPackage } = await import('./account-package-delete.ts')

function createUser(): AuthenticatedAppUser {
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
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'user',
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	}
}

function createSavedPackage() {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('account package delete requires the typed package name then removes the package', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()

	const missingId = await deleteAccountPackage({
		env,
		user,
		packageId: '',
		confirmName: '',
	})
	expect(missingId?.status).toBe(400)
	expect(missingId?.data).toEqual({
		ok: false,
		error: 'Package id is required.',
	})

	mockModule.writablePackage = null
	const missingPackage = await deleteAccountPackage({
		env,
		user,
		packageId: 'pkg-1',
		confirmName: '@user/notes',
	})
	expect(missingPackage?.status).toBe(404)
	expect(missingPackage?.data).toEqual({
		ok: false,
		error: 'Package not found.',
	})
	expect(mockModule.deleteSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.writablePackage = createSavedPackage()
	const wrongName = await deleteAccountPackage({
		env,
		user,
		packageId: 'pkg-1',
		confirmName: 'notes',
	})
	expect(wrongName?.status).toBe(400)
	expect(wrongName?.data).toEqual({
		ok: false,
		error: 'Type the package name "@user/notes" to delete it.',
	})
	expect(mockModule.deleteSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.deleteSavedPackageProjection.mockResolvedValue(undefined)
	const deleted = await deleteAccountPackage({
		env,
		user,
		packageId: 'pkg-1',
		confirmName: '@user/notes',
	})
	expect(deleted?.status).toBe(200)
	expect(deleted?.data).toEqual({
		ok: true,
		deleted: true,
		packageId: 'pkg-1',
	})
	expect(mockModule.deleteSavedPackageProjection).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('stable-user-1'),
		actorUserId: 'stable-user-1',
		packageId: 'pkg-1',
	})
})
