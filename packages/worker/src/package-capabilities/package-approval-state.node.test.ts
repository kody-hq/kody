import { expect, test } from 'vitest'
import { packageApprovalState } from './package-approval-state.ts'

test('package approvals resolve once by approval or supersession', () => {
	expect(packageApprovalState.can('pending', 'approved')).toBe(true)
	expect(packageApprovalState.can('pending', 'superseded')).toBe(true)
	expect(packageApprovalState.can('approved', 'superseded')).toBe(false)
	expect(packageApprovalState.isTerminal('approved')).toBe(true)
	expect(packageApprovalState.isTerminal('superseded')).toBe(true)
})
