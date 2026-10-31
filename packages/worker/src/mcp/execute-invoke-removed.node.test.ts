import { expect, test } from 'vitest'
import {
	executeInvokeEquivalentCode,
	executeInvokeRemovedMessage,
	hasRemovedExecuteInvoke,
} from './execute-invoke-removed.ts'

test('the removed invoke error shows the code form for each specifier shape', () => {
	const expected =
		'import action from "kody:@acme/github/listRepos"\nexport default (params) => action(params)'
	expect(executeInvokeEquivalentCode('kody:@acme/github/listRepos')).toBe(
		expected,
	)
	expect(executeInvokeEquivalentCode('@acme/github/listRepos')).toBe(expected)
	expect(executeInvokeEquivalentCode(' @acme/github#./listRepos ')).toBe(
		expected,
	)
	expect(executeInvokeEquivalentCode('@acme/github#')).toBe(
		'import action from "kody:@acme/github"\nexport default (params) => action(params)',
	)
	for (const unusable of ['', 'not a specifier', 42, null, 'kody:@acme']) {
		expect(executeInvokeEquivalentCode(unusable)).toContain(
			'"kody:@scope/package/export"',
		)
	}

	const message = executeInvokeRemovedMessage('@acme/github#listRepos')
	expect(message).toContain('execute no longer accepts `invoke`')
	expect(message).toContain(expected)
	expect(message).toContain(`"code": ${JSON.stringify(expected)}`)
	expect(message).not.toContain('\u2014')
})

test('only a present invoke key counts as a removed-field call', () => {
	expect(hasRemovedExecuteInvoke({ invoke: 'kody:@a/b/c' })).toBe(true)
	expect(hasRemovedExecuteInvoke({ invoke: '' })).toBe(true)
	expect(hasRemovedExecuteInvoke({ invoke: undefined })).toBe(false)
	expect(hasRemovedExecuteInvoke({ code: 'export default 1' })).toBe(false)
	expect(hasRemovedExecuteInvoke(null)).toBe(false)
	expect(hasRemovedExecuteInvoke(['invoke'])).toBe(false)
})
