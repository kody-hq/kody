import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { testAccountAvatarApiPostHandler } from './account-avatar.test-support.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	processUserAvatar: vi.fn(),
	saveUserAvatar: vi.fn(),
	deleteUserAvatar: vi.fn(),
	loadAccountProfileData: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/avatar.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#worker/community/avatar.ts')>()),
	processUserAvatar: (...args: Array<unknown>) =>
		mocks.processUserAvatar(...args),
	saveUserAvatar: (...args: Array<unknown>) => mocks.saveUserAvatar(...args),
	deleteUserAvatar: (...args: Array<unknown>) =>
		mocks.deleteUserAvatar(...args),
}))

vi.mock('#app/account-profile-data.ts', () => ({
	loadAccountProfileData: (...args: Array<unknown>) =>
		mocks.loadAccountProfileData(...args),
}))

const authedUser = {
	userId: 1,
	email: 'alice@example.com',
	emailVerified: true,
	username: 'alice',
	displayName: 'Alice',
	mcpUser: {
		userId: ownerIdFromStored('stable-alice'),
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	},
}

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COMMUNITY_ASSETS: {} as R2Bucket,
	} as Env
}

test('account avatar API auth, upload, remove, and invalid type', async () => {
	const handler = testAccountAvatarApiPostHandler(createEnv())

	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.execute({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(unauthorized.status).toBe(401)
	expect((unauthorized.data as { ok: boolean }).ok).toBe(false)

	mocks.readAuthenticatedAppUser.mockResolvedValue(authedUser)
	mocks.processUserAvatar.mockReturnValue({
		bytes: Uint8Array.from([1, 2, 3]),
		contentType: 'image/png',
	})
	mocks.saveUserAvatar.mockResolvedValue('user-avatars/stable-alice/hash.png')
	mocks.loadAccountProfileData.mockRejectedValue(
		new Error('Profile read unavailable'),
	)

	const form = new FormData()
	form.set(
		'avatar',
		new File([Uint8Array.from([1, 2, 3])], 'avatar.png', {
			type: 'image/png',
		}),
	)
	const upload = await handler.execute({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
			body: form,
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(upload.status).toBe(200)
	expect(upload.data).toEqual({
		ok: true,
		avatarUrl: '/profiles/alice/avatar/hash.png',
	})
	expect(mocks.loadAccountProfileData).not.toHaveBeenCalled()
	expect(mocks.saveUserAvatar).toHaveBeenCalledWith(
		expect.objectContaining({
			numericUserId: 1,
			stableUserId: ownerIdFromStored('stable-alice'),
			contentType: 'image/png',
		}),
	)

	mocks.deleteUserAvatar.mockResolvedValue(undefined)
	const remove = await handler.execute({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ remove: true }),
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(remove.status).toBe(200)
	expect(remove.data).toMatchObject({ avatarUrl: null })
	expect(mocks.deleteUserAvatar).toHaveBeenCalledWith(
		expect.objectContaining({
			numericUserId: 1,
			stableUserId: ownerIdFromStored('stable-alice'),
		}),
	)

	mocks.processUserAvatar.mockImplementation(() => {
		throw new Error('Avatars must be PNG, JPEG, or WebP images.')
	})
	const invalidForm = new FormData()
	invalidForm.set(
		'avatar',
		new File([Uint8Array.from([1])], 'avatar.svg', { type: 'image/svg+xml' }),
	)
	const invalid = await handler.execute({
		request: new Request('http://example.com/account/profile/avatar.json', {
			method: 'POST',
			body: invalidForm,
		}),
		url: new URL('http://example.com/account/profile/avatar.json'),
		params: {},
	} as never)
	expect(invalid.status).toBe(400)
	expect((invalid.data as { ok: boolean }).ok).toBe(false)
})
