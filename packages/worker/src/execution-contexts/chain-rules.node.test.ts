import { expect, test } from 'vitest'
import { selfShareError } from './chain-rules.ts'

test('selfShareError refuses sharing a context with its own operator', () => {
	expect(
		selfShareError('user_operator', [{ type: 'user', id: 'user_operator' }]),
	).toMatch(/operator/)
	expect(
		selfShareError('user_operator', [
			{ type: 'user', id: 'user_friend' },
			{ type: 'team', id: 'user_operator' },
		]),
	).toBeNull()
	expect(selfShareError('user_operator', [])).toBeNull()
})
