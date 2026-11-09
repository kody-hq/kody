import { expect, test } from 'vitest'
import { planTransferState } from './plan-transfer-state.ts'

test('org_plan_transfers.status preserves the lifecycle graph', () => {
	expect(planTransferState.initial).toEqual(['pending_checkout', 'needs_retry'])
	expect(planTransferState.transitions).toEqual({
		pending_checkout: ['applying', 'canceled'],
		applying: [
			'applying',
			'pending_checkout',
			'needs_retry',
			'completed',
			'canceled',
		],
		needs_retry: ['applying', 'canceled'],
		completed: [],
		canceled: [],
	})
	expect(planTransferState.terminal).toEqual(['completed', 'canceled'])
	expect(
		planTransferState.states.filter(
			(status) => !planTransferState.isTerminal(status),
		),
	).toEqual(['pending_checkout', 'applying', 'needs_retry'])
})
