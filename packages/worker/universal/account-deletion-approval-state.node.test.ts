import { expect, test } from 'vitest'
import { accountDeletionApprovalState } from './account-deletion-approval-state.ts'
import {
	canHandle,
	finalStatesOf,
	nextState,
	sqlSourcesOf,
} from '@kody-internal/shared/state-machine.ts'

test('deletion approvals can roll consumption back, and expiry stays terminal', () => {
	expect(
		nextState(accountDeletionApprovalState, 'pending', { type: 'CONSUME' }),
	).toBe('consumed')
	expect(
		nextState(accountDeletionApprovalState, 'pending', { type: 'EXPIRE' }),
	).toBe('expired')
	expect(
		nextState(accountDeletionApprovalState, 'consumed', { type: 'ROLLBACK' }),
	).toBe('pending')
	expect(canHandle(accountDeletionApprovalState, 'consumed', 'EXPIRE')).toBe(
		false,
	)
	expect(finalStatesOf(accountDeletionApprovalState)).toEqual(['expired'])
	expect(canHandle(accountDeletionApprovalState, 'expired', 'ROLLBACK')).toBe(
		false,
	)
	expect(sqlSourcesOf(accountDeletionApprovalState, 'CONSUME')).toBe(
		"('pending')",
	)
	expect(sqlSourcesOf(accountDeletionApprovalState, 'ROLLBACK')).toBe(
		"('consumed')",
	)
	expect(sqlSourcesOf(accountDeletionApprovalState, 'EXPIRE')).toBe(
		"('pending')",
	)
})
