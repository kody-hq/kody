import { expect, test } from 'vitest'
import { packageApprovalState } from './package-approval-state.ts'

test('package_approval_requests.status preserves the lifecycle graph', () => {
	expect(packageApprovalState.initial).toEqual(['pending'])
	expect(packageApprovalState.transitions).toEqual({
		pending: ['approved', 'superseded'],
		approved: [],
		superseded: [],
	})
	expect(packageApprovalState.terminal).toEqual(['approved', 'superseded'])
})
