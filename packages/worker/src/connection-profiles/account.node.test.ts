import { beforeEach, expect, test, vi } from 'vitest'
import {
	createAccountConnectionProfile,
	updateAccountConnectionProfile,
	deleteAccountConnectionProfile,
} from './account.ts'

const mocks = vi.hoisted(() => ({
	enabled: vi.fn().mockResolvedValue(true),
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	list: vi.fn().mockRejectedValue(new Error('Profile listing unavailable')),
	packages: vi.fn().mockRejectedValue(new Error('Package listing unavailable')),
}))
vi.mock('#worker/feature-flags/service.ts', () => ({
	isFeatureEnabled: mocks.enabled,
}))
vi.mock('#worker/connection-profiles/repo.ts', () => ({
	createConnectionProfile: mocks.create,
	updateConnectionProfile: mocks.update,
	deleteConnectionProfile: mocks.remove,
	listConnectionProfiles: mocks.list,
}))
vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.packages,
}))

beforeEach(() => {
	mocks.enabled.mockResolvedValue(true)
	mocks.list.mockRejectedValue(new Error('Profile listing unavailable'))
	mocks.packages.mockRejectedValue(new Error('Package listing unavailable'))
})

const context = {
	env: {
		APP_DB: {
			prepare: () => ({ bind: () => ({ first: async () => ({ id: 1 }) }) }),
		},
	} as unknown as Env,
	userId: 'person-1',
	requestUrl: 'https://example.com/_serverFn/profile',
	emailVerified: true,
}

test('profile writes preserve their operation output without requiring page reads', async () => {
	const created = { id: 'profile-1', name: 'work', grants: [] }
	mocks.create.mockResolvedValueOnce(created)
	mocks.update.mockResolvedValueOnce({ ...created, name: 'updated' })
	mocks.remove.mockResolvedValueOnce(undefined)
	expect(
		await createAccountConnectionProfile({
			...context,
			name: 'work',
			grants: [],
		}),
	).toEqual({ ok: true, result: created })
	expect(
		await updateAccountConnectionProfile({
			...context,
			profileId: created.id,
			name: 'updated',
		}),
	).toEqual({ ok: true, result: { ...created, name: 'updated' } })
	expect(
		await deleteAccountConnectionProfile({ ...context, profileId: created.id }),
	).toEqual({ ok: true, result: undefined })
	expect(mocks.list).not.toHaveBeenCalled()
	expect(mocks.packages).not.toHaveBeenCalled()
})

test('disabled profiles fail closed before invoking the write', async () => {
	mocks.enabled.mockResolvedValueOnce(false)
	mocks.create.mockClear()
	expect(
		await createAccountConnectionProfile({
			...context,
			name: 'blocked',
			grants: [],
		}),
	).toMatchObject({ ok: false, status: 404 })
	expect(mocks.create).not.toHaveBeenCalled()
})
