import { expect, test } from 'vitest'
import { adminCodemodRunInputSchema } from '#universal/admin-codemod-input.ts'

test('website codemod input preserves the enforcement scope alongside explicit filters', () => {
	const input = {
		codemodId: 'example',
		mode: 'apply',
		scope: 'fleet',
		filters: { scope: 'credential-need-enforcement', packageIds: ['pkg-1'] },
	}
	expect(adminCodemodRunInputSchema.parse(input)).toEqual(input)
})

test('website codemod input rejects unknown scopes and empty narrowing filters', () => {
	const input = { codemodId: 'example', mode: 'apply', scope: 'fleet' }
	for (const filters of [
		{ scope: 'unknown' },
		{ scope: null },
		{ packageIds: [] },
		{ userIds: [' '] },
	]) {
		expect(
			adminCodemodRunInputSchema.safeParse({ ...input, filters }).success,
		).toBe(false)
	}
	expect(
		adminCodemodRunInputSchema.safeParse({
			codemodId: 'example',
			mode: 'apply',
		}).success,
	).toBe(false)
})
