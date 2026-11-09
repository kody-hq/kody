import { expect, test } from 'vitest'
import { accountDeletionApprovalState } from './account-deletion-approval-state.ts'

test('admin_account_deletion_approvals.lifecycle preserves the lifecycle graph', () => {
	expect(accountDeletionApprovalState.initial).toEqual(['pending'])
	expect(accountDeletionApprovalState.transitions).toEqual({
		pending: ['consumed', 'expired'],
		consumed: ['pending', 'expired'],
		expired: [],
	})
	expect(accountDeletionApprovalState.terminal).toEqual(['expired'])
})
