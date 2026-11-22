import { expect, test } from 'vitest'
import { assertNever } from '#worker/scheduled/lane-failure.ts'

type Failure = { kind: 'a' } | { kind: 'b' }

function mapFailure(failure: Failure) {
	switch (failure.kind) {
		case 'a':
			return 1
		default:
			// @ts-expect-error an unmapped kind leaves `failure` typed as `{ kind: 'b' }`, not never
			return assertNever(failure, 'test failure')
	}
}

test('assertNever throws with the context and value when a kind reaches it at runtime', () => {
	expect(mapFailure({ kind: 'a' })).toBe(1)
	expect(() => mapFailure({ kind: 'b' })).toThrow(
		'Unhandled test failure: {"kind":"b"}',
	)
})
