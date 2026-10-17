import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type CommunityProfileRecord } from '#worker/community/types.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createProfileOgImageHandler } from './profile.ts'

const mocks = vi.hoisted(() => ({
	getCommunityProfileByUsername: vi.fn(),
	getUserAvatarObject: vi.fn(),
	renderProfileOgImage: vi.fn(),
}))

vi.mock('#worker/community/profile-service.ts', () => ({
	getCommunityProfileByUsername: (...args: Array<unknown>) =>
		mocks.getCommunityProfileByUsername(...args),
}))

vi.mock('#worker/community/avatar.ts', () => ({
	getUserAvatarObject: (...args: Array<unknown>) =>
		mocks.getUserAvatarObject(...args),
}))

vi.mock('#worker/community/profile-og-image.ts', () => ({
	renderProfileOgImage: (...args: Array<unknown>) =>
		mocks.renderProfileOgImage(...args),
}))

const publicProfile = {
	userId: ownerIdFromStored('stable-alice'),
	username: 'alice',
	displayName: 'Alice',
	bio: 'Hello from Alice',
	avatarKey: 'user-avatars/stable-alice/abcdef.png',
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	publicPackageCount: 1,
	listingCount: 1,
} satisfies CommunityProfileRecord

const tinyPng = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
	0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
	0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
	0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
])

test('profile OG image public PNG, avatar fallback, and unavailable profiles', async () => {
	mocks.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mocks.getUserAvatarObject.mockResolvedValue({
		httpMetadata: { contentType: 'image/png' },
		arrayBuffer: async () => tinyPng.buffer.slice(0),
	})
	mocks.renderProfileOgImage.mockResolvedValue(tinyPng)

	const handler = createProfileOgImageHandler({} as Env)
	const publicResponse = await handler({
		request: new Request('https://example.com/profiles/alice/og.png'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/og.png'),
	} as never)
	expect(publicResponse.status).toBe(200)
	expect(publicResponse.headers.get('Content-Type')).toBe('image/png')
	expect(publicResponse.headers.get('Cache-Control')).toBe(
		'public, max-age=3600',
	)
	expect(mocks.renderProfileOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			displayName: 'Alice',
			username: 'alice',
			avatarDataUri: expect.stringMatching(/^data:image\/png;base64,/),
		}),
	)

	consoleError.mockImplementation(() => {})
	mocks.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mocks.getUserAvatarObject.mockRejectedValue(new Error('r2 unavailable'))
	mocks.renderProfileOgImage.mockResolvedValue(tinyPng)
	const fallbackResponse = await handler({
		request: new Request('https://example.com/profiles/alice/og.png'),
		params: { username: 'alice' },
		url: new URL('https://example.com/profiles/alice/og.png'),
	} as never)
	expect(fallbackResponse.status).toBe(200)
	expect(mocks.renderProfileOgImage).toHaveBeenCalledWith(
		expect.objectContaining({ avatarDataUri: null }),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'profile-og-avatar-load-failed',
		'alice',
		expect.any(Error),
	)

	mocks.getCommunityProfileByUsername.mockResolvedValue(null)
	const unavailable = await handler({
		request: new Request('https://example.com/profiles/secret/og.png'),
		params: { username: 'secret' },
		url: new URL('https://example.com/profiles/secret/og.png'),
	} as never)
	expect(unavailable.status).toBe(404)
})
