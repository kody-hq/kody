import { expect, test } from 'vitest'
import {
	defaultPrePushRelatedTestCap,
	directRelatedTestFiles,
	prePushRelatedTestCap,
	selectPrePushRelatedTests,
} from './vitest-related-capped.ts'

const source = '/repo/packages/worker/src/mcp/capabilities/capabilities.ts'
const related = [
	'/repo/packages/worker/src/mcp/capabilities/capabilities.test.ts',
	'/repo/packages/worker/src/mcp/capabilities/capabilities.workers.test.ts',
	'/repo/packages/worker/src/mcp/capabilities/capabilities-extra.test.ts',
	'/repo/packages/worker/src/mcp/search/search.test.ts',
	'/repo/tools/new.node.test.ts',
]

test('runs every related test at or under the cap', () => {
	expect(
		selectPrePushRelatedTests({ related, pushed: [source], cap: 5 }),
	).toEqual({ files: related, capped: false })
})

test('above the cap keeps pushed tests and same-named siblings only', () => {
	expect(
		selectPrePushRelatedTests({
			related,
			pushed: [source, '/repo/tools/new.node.test.ts'],
			cap: 2,
		}),
	).toEqual({
		files: [
			'/repo/packages/worker/src/mcp/capabilities/capabilities.test.ts',
			'/repo/packages/worker/src/mcp/capabilities/capabilities.workers.test.ts',
			'/repo/tools/new.node.test.ts',
		],
		capped: true,
	})
	expect(directRelatedTestFiles({ related, pushed: [] })).toEqual([])
})

test('cap reads KODY_PRE_PUSH_RELATED_TEST_CAP', () => {
	expect(prePushRelatedTestCap({})).toBe(defaultPrePushRelatedTestCap)
	expect(prePushRelatedTestCap({ KODY_PRE_PUSH_RELATED_TEST_CAP: '40' })).toBe(
		40,
	)
	expect(prePushRelatedTestCap({ KODY_PRE_PUSH_RELATED_TEST_CAP: 'all' })).toBe(
		Number.POSITIVE_INFINITY,
	)
	expect(prePushRelatedTestCap({ KODY_PRE_PUSH_RELATED_TEST_CAP: '-1' })).toBe(
		defaultPrePushRelatedTestCap,
	)
})
