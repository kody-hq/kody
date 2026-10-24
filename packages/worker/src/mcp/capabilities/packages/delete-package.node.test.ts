import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	deleteSavedPackageProjection: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	deleteSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackageProjection(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

const { deletePackageCapability } = await import('./delete-package.ts')

function createCtx(userId = 'user-1') {
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: userId,
		ownerScope: 'user',
		ownerEmail: 'user@example.com',
		actorUserId: userId,
	})
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

function createSavedPackage() {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		kodyId: 'notes',
		name: '@user/notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		sourceId: 'source-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('packageDelete requires the owner-typed package name before deleting', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.deleteSavedPackageProjection.mockResolvedValue(undefined)
	const expectedError =
		'This permanently deletes "@user/notes". It removes the package from the account, stops its jobs, clears package storage and package-scoped secrets, unlists a public catalog entry if one exists, and best-effort deletes Artifacts repos. Existing forks keep their copies. This cannot be undone. Hiding or making the package private is not deletion. Do not call this unless the owner explicitly asked to delete this package and typed its name. Then pass confirm_name: "@user/notes" (the package name).'

	const missingName = await deletePackageCapability
		.handler({ package_id: 'pkg-1' }, createCtx())
		.catch((error: unknown) => error)
	expect(missingName).toBeInstanceOf(McpCallerError)
	expect(missingName).toMatchObject({ message: expectedError })
	expect(mockModule.deleteSavedPackageProjection).not.toHaveBeenCalled()

	const wrongName = await deletePackageCapability
		.handler({ package_id: 'pkg-1', confirm_name: 'notes' }, createCtx())
		.catch((error: unknown) => error)
	expect(wrongName).toBeInstanceOf(McpCallerError)
	expect(wrongName).toMatchObject({ message: expectedError })
	expect(mockModule.deleteSavedPackageProjection).not.toHaveBeenCalled()

	await expect(
		deletePackageCapability.handler(
			{ package_id: 'pkg-1', confirm_name: '@user/notes' },
			createCtx(),
		),
	).resolves.toEqual({
		ok: true,
		package_id: 'pkg-1',
	})
	expect(mockModule.deleteSavedPackageProjection).toHaveBeenCalledWith({
		audit: null,
		env: expect.objectContaining({ APP_DB: {} }),
		userId: ownerIdFromStored('user-1'),
		actorUserId: 'user-1',
		packageId: 'pkg-1',
	})

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	await expect(
		deletePackageCapability.handler(
			{ package_id: 'missing', confirm_name: '@user/notes' },
			createCtx(),
		),
	).rejects.toThrow(/not found/i)
	expect(mockModule.deleteSavedPackageProjection).toHaveBeenCalledTimes(1)

	await expect(
		deletePackageCapability.handler(
			{ package_id: 'pkg-1', confirm_name: '@user/notes' },
			{
				env: { APP_DB: {} } as Env,
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://heykody.dev',
					user: null,
				}),
			},
		),
	).rejects.toThrow(/authenticated/i)
})
