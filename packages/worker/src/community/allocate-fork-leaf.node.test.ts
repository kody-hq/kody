import { expect, test } from 'vitest'
import { resolveCommunityForkAlternateLeaf } from './allocate-fork-leaf.ts'

test('resolveCommunityForkAlternateLeaf skips reserved and taken leaves', async () => {
	expect(
		await resolveCommunityForkAlternateLeaf({
			preferredLeaf: 'discord-gateway',
			reservedLeaves: new Set(['discord-gateway-2']),
			isLeafTaken: async (leaf) => leaf === 'discord-gateway-3',
		}),
	).toBe('discord-gateway-4')

	expect(
		await resolveCommunityForkAlternateLeaf({
			preferredLeaf: 'demo',
			reservedLeaves: new Set(['demo-2']),
			isLeafTaken: async () => true,
			maxAttempts: 2,
		}),
	).toBeNull()
})
