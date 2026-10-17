import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ authorize: vi.fn(), clear: vi.fn() }))
vi.mock('#worker/authorization/authorize.ts', () => ({
	authorize: state.authorize,
}))
vi.mock('#worker/email/outbound-consecutive-failures.ts', () => ({
	clearOutboundDeliveryPause: state.clear,
}))
import { resumeAccountOutboundDelivery } from './account-email.ts'
const env = { APP_DB: {} } as Env
const user = {
	request: { org: { id: 'team-mailbox' } },
	mcpUser: { userId: 'person-a' },
} as unknown as Parameters<typeof resumeAccountOutboundDelivery>[0]['user']
test('resuming outbound requires write authority before clearing only the bound mailbox owner pause', async () => {
	state.authorize.mockRejectedValueOnce(new Error('Missing email:write'))
	await expect(resumeAccountOutboundDelivery({ env, user })).rejects.toThrow(
		'Missing email:write',
	)
	expect(state.clear).not.toHaveBeenCalled()
	state.authorize.mockResolvedValue(undefined)
	expect((await resumeAccountOutboundDelivery({ env, user })).data).toEqual({
		ok: true,
	})
	expect(state.authorize).toHaveBeenLastCalledWith(
		{ env, request: user.request },
		'email:write',
	)
	expect(state.clear).toHaveBeenLastCalledWith({
		db: env.APP_DB,
		ownerId: 'team-mailbox',
	})
})
