import { expect, test } from 'vitest'
import {
	computeIncludeHeadsUpKvKey,
	formatComputeIncludeHeadsUp,
} from '#mcp/compute-include-heads-up.ts'

const usageUrl = 'https://kody.codes/@acme/-/usage'

test('heads-up starts at 80% of the include', () => {
	expect(
		formatComputeIncludeHeadsUp({
			used: 279,
			include: 350,
			creditWallet: 'empty',
			usageUrl,
		}),
	).toBeNull()
	const text = formatComputeIncludeHeadsUp({
		used: 280,
		include: 350,
		creditWallet: 'empty',
		usageUrl,
	})
	expect(text).toContain('used 280 of 350 included Worker compute units')
	expect(text).toContain('(80%)')
	expect(text).toContain('stop until credits are added')
	expect(text).toContain(`${usageUrl}#where-it-went`)
})

test('funded wallets hear that past-include units spend credits', () => {
	expect(
		formatComputeIncludeHeadsUp({
			used: 1544,
			include: 350,
			creditWallet: 'funded',
			usageUrl,
		}),
	).toContain('used 1,544 of 350')
	expect(
		formatComputeIncludeHeadsUp({
			used: 1544,
			include: 350,
			creditWallet: 'funded',
			usageUrl,
		}),
	).toContain('spend credits')
})

test('wallet-less plans and empty includes get no heads-up', () => {
	expect(
		formatComputeIncludeHeadsUp({
			used: 500,
			include: 350,
			creditWallet: 'none',
			usageUrl,
		}),
	).toBeNull()
	expect(
		formatComputeIncludeHeadsUp({
			used: 5,
			include: 0,
			creditWallet: 'empty',
			usageUrl,
		}),
	).toBeNull()
})

test('claim key is per org and per UTC month', () => {
	expect(
		computeIncludeHeadsUpKvKey('org-1', new Date('2026-10-31T23:59:59Z')),
	).not.toBe(
		computeIncludeHeadsUpKvKey('org-1', new Date('2026-11-01T00:00:00Z')),
	)
	expect(
		computeIncludeHeadsUpKvKey('org-1', new Date('2026-10-01T00:00:00Z')),
	).toBe(computeIncludeHeadsUpKvKey('org-1', new Date('2026-10-31T00:00:00Z')))
})
