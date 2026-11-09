import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { packageApprovalState } from './package-approval-state.ts'

test('package approvals resolve once by approval or supersession', () => {
	expect(canHandle(packageApprovalState, 'pending', 'APPROVE')).toBe(true)
	expect(canHandle(packageApprovalState, 'pending', 'SUPERSEDE')).toBe(true)
	expect(canHandle(packageApprovalState, 'approved', 'SUPERSEDE')).toBe(false)
	expect(finalStatesOf(packageApprovalState).includes('approved')).toBe(true)
	expect(finalStatesOf(packageApprovalState).includes('superseded')).toBe(true)
})
