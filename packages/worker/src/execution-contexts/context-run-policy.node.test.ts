import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { assertContextRunAllowed } from './context-run-policy.ts'

const user = {
	userId: personIdFromStored('a'.repeat(64)),
	email: 'ada@example.com',
	username: 'ada',
	displayName: 'Ada',
}

function contextRun(byOperator: boolean) {
	return deriveRequestContext({
		user,
		source: { kind: 'execution-context-run', ecid: 'ec_1', runId: 'run_1' },
		contextRunByOperator: byOperator,
	})
}

test("the operator's own context runs call contextRuns: 'deny' capabilities as in cloud", () => {
	expect(() =>
		assertContextRunAllowed(contextRun(true), 'secretSet', 'deny'),
	).not.toThrow()
})

test("anyone else's context runs are refused contextRuns: 'deny' capabilities", () => {
	expect(() =>
		assertContextRunAllowed(contextRun(false), 'secretSet', 'deny'),
	).toThrow(
		/secretSet is only available to the operator's own runs.*context_run_denied/,
	)
	expect(() =>
		assertContextRunAllowed(contextRun(false), 'packageGet', 'allow'),
	).not.toThrow()
})

test('the operator flag only applies to execution-context runs', () => {
	const session = deriveRequestContext({
		user,
		source: { kind: 'session' },
		contextRunByOperator: true,
	})
	expect(session.credential.contextRunByOperator).toBeUndefined()
})
