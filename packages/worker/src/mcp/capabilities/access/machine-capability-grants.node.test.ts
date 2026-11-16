import { expect, test } from 'vitest'
import { authorizeGrantTarget } from './shared.ts'

test('accessGrant refuses to add a machine access grant before it reads anything', async () => {
	const ctx = {
		env: {},
		callerContext: {
			user: { userId: 'user_cole' },
			request: { org: { id: 'org_acme' } },
		},
	} as unknown as Parameters<typeof authorizeGrantTarget>[0]
	await expect(
		authorizeGrantTarget(ctx, 'machine_capability', 'mc_1'),
	).rejects.toThrow('accessGrant does not add machine access grants.')
})
