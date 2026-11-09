import { IllegalStateTransitionError } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { planTransferState } from './plan-transfer-state.ts'

test('org_plan_transfers.status leases applying work and cannot leave a terminal', () => {
	expect(planTransferState.can('applying', 'applying')).toBe(true)
	expect(planTransferState.can('pending_checkout', 'completed')).toBe(false)
	expect(planTransferState.can('completed', 'applying')).toBe(false)
	expect(planTransferState.can('canceled', 'pending_checkout')).toBe(false)
	expect(
		planTransferState.states.filter(
			(status) => !planTransferState.isTerminal(status),
		),
	).toEqual(['pending_checkout', 'applying', 'needs_retry'])
	expect(
		planTransferState.guard({
			from: ['pending_checkout', 'needs_retry'],
			to: 'applying',
		}),
	).toBe("('pending_checkout', 'needs_retry')")
	expect(planTransferState.guard({ from: 'applying', to: 'completed' })).toBe(
		"('applying')",
	)
	expect(() =>
		planTransferState.guard({ from: 'completed', to: 'applying' }),
	).toThrow(IllegalStateTransitionError)
})
