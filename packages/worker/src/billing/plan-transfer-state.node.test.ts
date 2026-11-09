import {
	canHandle,
	statesOf,
	finalStatesOf,
	sqlSourcesOf,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'

import { expect, test } from 'vitest'
import { planTransferState } from './plan-transfer-state.ts'

test('org_plan_transfers.status leases applying work and cannot leave a terminal', () => {
	expect(canHandle(planTransferState, 'applying', 'CLAIM_LEASE')).toBe(true)
	expect(canHandle(planTransferState, 'pending_checkout', 'COMPLETE')).toBe(
		false,
	)
	expect(canHandle(planTransferState, 'completed', 'CLAIM_LEASE')).toBe(false)
	expect(canHandle(planTransferState, 'canceled', 'RELEASE_CHECKOUT')).toBe(
		false,
	)
	expect(
		statesOf(planTransferState).filter(
			(status) => !finalStatesOf(planTransferState).includes(status),
		),
	).toEqual(['pending_checkout', 'applying', 'needs_retry'])
	expect(
		sqlSourcesOf(planTransferState, 'CLAIM_LEASE', [
			'pending_checkout',
			'needs_retry',
		]),
	).toBe("('pending_checkout', 'needs_retry')")
	expect(sqlSourcesOf(planTransferState, 'COMPLETE', ['applying'])).toBe(
		"('applying')",
	)
	expect(() =>
		sqlSourcesOf(planTransferState, 'CLAIM_LEASE', ['completed']),
	).toThrow(IllegalStateTransitionError)
})
