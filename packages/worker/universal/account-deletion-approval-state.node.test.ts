import { expect, test } from 'vitest'
import { accountDeletionApprovalState } from './account-deletion-approval-state.ts'

test('deletion approvals can roll consumption back, and expiry stays terminal', () => {
	expect(accountDeletionApprovalState.can('pending', 'consumed')).toBe(true)
	expect(accountDeletionApprovalState.can('pending', 'expired')).toBe(true)
	expect(accountDeletionApprovalState.can('consumed', 'pending')).toBe(true)
	expect(accountDeletionApprovalState.can('consumed', 'expired')).toBe(true)
	expect(accountDeletionApprovalState.isTerminal('expired')).toBe(true)
	expect(accountDeletionApprovalState.can('expired', 'pending')).toBe(false)
})
