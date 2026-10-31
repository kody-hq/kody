import { expect, test, vi } from 'vitest'
import { type ApiInvocationContext } from './context.ts'

const createProfile = vi.fn()
const revokeProfile = vi.fn()

vi.mock('#worker/profiles/service.ts', () => ({
	requireProfilesCaller: async () => ({ orgId: 'org_acme' }),
	createProfile: (...args: Array<unknown>) => createProfile(...args),
	revokeProfile: (...args: Array<unknown>) => revokeProfile(...args),
}))

const { tokenOperationDefinitions } = await import('./token-operations.ts')

const profile = {
	id: 'prf_child',
	name: 'child',
	parentProfileId: 'prf_root',
	effectiveExpiresAt: null,
}
const ctx = {
	callerContext: { request: { credential: { profileId: 'prf_root' } } },
} as unknown as ApiInvocationContext

test('profileHandoff mints a short-lived token for the new sub-profile by default', async () => {
	createProfile.mockResolvedValueOnce(profile)
	const tokenCreate = vi
		.spyOn(tokenOperationDefinitions.tokenCreate, 'handler')
		.mockResolvedValueOnce({ id: 'tok_1' })
	const result = await tokenOperationDefinitions.profileHandoff.handler(
		{ name: 'child', scopes: ['org:read'] },
		ctx,
	)
	expect(createProfile.mock.calls[0]?.[1]).toMatchObject({
		name: 'child',
		parentProfileId: 'prf_root',
	})
	expect(tokenCreate).toHaveBeenCalledWith(
		{
			name: 'handoff child',
			scopes: ['org:read'],
			lifetime: 'short',
			profile_id: 'prf_child',
		},
		ctx,
	)
	expect(result).toMatchObject({
		profile: { id: 'prf_child', parent_profile_id: 'prf_root' },
		token: { id: 'tok_1' },
	})
	tokenCreate.mockRestore()
})

test('profileHandoff revokes the new sub-profile when minting fails', async () => {
	createProfile.mockResolvedValueOnce(profile)
	revokeProfile.mockResolvedValueOnce(undefined)
	const tokenCreate = vi
		.spyOn(tokenOperationDefinitions.tokenCreate, 'handler')
		.mockRejectedValueOnce(new Error('mint failed'))
	await expect(
		tokenOperationDefinitions.profileHandoff.handler(
			{ name: 'child', scopes: ['org:read'], lifetime: 'long' },
			ctx,
		),
	).rejects.toThrow('mint failed')
	expect(tokenCreate.mock.calls[0]?.[0]).toMatchObject({ lifetime: 'long' })
	expect(revokeProfile.mock.calls[0]?.[1]).toEqual({ profileId: 'prf_child' })
	tokenCreate.mockRestore()
})
