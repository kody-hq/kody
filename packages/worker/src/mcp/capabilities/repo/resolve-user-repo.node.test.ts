import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getUserRepoById: vi.fn(),
	getUserRepoByName: vi.fn(),
	getEntitySourceByEntity: vi.fn(),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	getUserRepoById: (...args: Array<unknown>) =>
		mockModule.getUserRepoById(...args),
	getUserRepoByName: (...args: Array<unknown>) =>
		mockModule.getUserRepoByName(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByEntity: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByEntity(...args),
}))

const { resolveOwnedUserRepo } = await import('./resolve-user-repo.ts')

const userId = ownerIdFromStored('user-1')
const db = {} as D1Database

const userRepo = {
	id: '11111111-1111-4111-8111-111111111111',
	user_id: userId,
	name: 'notes',
	description: null,
	is_private: 1,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

const source = {
	id: 'source-1',
	user_id: userId,
	entity_kind: 'repo' as const,
	entity_id: userRepo.id,
	repo_id: 'artifacts-notes',
	published_commit: null,
	indexed_commit: null,
	namespace: 'default',
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) fn.mockReset()
	mockModule.getEntitySourceByEntity.mockResolvedValue(source)
}

test('resolveOwnedUserRepo resolves names and prefers matching ids', async () => {
	resetMocks()
	mockModule.getUserRepoByName.mockResolvedValue(userRepo)
	const byName = await resolveOwnedUserRepo({
		db,
		userId,
		args: { name: 'notes' },
	})
	expect(byName.userRepo.id).toBe(userRepo.id)
	expect(byName.source.id).toBe(source.id)
	expect(mockModule.getUserRepoById).not.toHaveBeenCalled()

	resetMocks()
	mockModule.getUserRepoById.mockResolvedValue(userRepo)
	const byIdResult = await resolveOwnedUserRepo({
		db,
		userId,
		args: { repo_id: userRepo.id },
	})
	expect(byIdResult.userRepo.id).toBe(userRepo.id)
	expect(mockModule.getUserRepoByName).not.toHaveBeenCalled()

	resetMocks()
	const conflictingIdResult = { ...userRepo, name: 'other' }
	mockModule.getUserRepoById.mockResolvedValue(conflictingIdResult)
	mockModule.getUserRepoByName.mockResolvedValue(userRepo)
	const preferred = await resolveOwnedUserRepo({
		db,
		userId,
		args: { repo_id: userRepo.id },
	})
	expect(preferred.userRepo.name).toBe('other')
	expect(mockModule.getUserRepoByName).not.toHaveBeenCalled()
})

test('resolveOwnedUserRepo validates identifiers and reports missing repos', async () => {
	resetMocks()
	await expect(resolveOwnedUserRepo({ db, userId, args: {} })).rejects.toThrow(
		McpCallerError,
	)
	await expect(
		resolveOwnedUserRepo({
			db,
			userId,
			args: { repo_id: userRepo.id, name: 'notes' },
		}),
	).rejects.toThrow(/exactly one/)

	resetMocks()
	mockModule.getUserRepoById.mockResolvedValue(null)
	mockModule.getUserRepoByName.mockResolvedValue(null)
	await expect(
		resolveOwnedUserRepo({ db, userId, args: { repo_id: 'missing' } }),
	).rejects.toThrow(/Plain repo "missing" was not found/)
})
