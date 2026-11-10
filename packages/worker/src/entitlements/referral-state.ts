import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const referralState = setup({
	schemas: { events: { REJECT_FRAUD: types<{}>(), REWARD: types<{}>() } },
}).createMachine({
	id: 'referrals.status',
	description:
		'Pending referrals reject fraud or reward qualifying invoices; incomplete reward delivery may retry, but rejected referrals cannot be rewarded.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				REJECT_FRAUD: { target: 'rejected' },
				REWARD: { target: 'rewarded' },
			},
		},
		rewarded: { on: { REWARD: { target: 'rewarded' } } },
		rejected: { type: 'final' },
	},
})

export type ReferralStatus = LifecycleStateOf<typeof referralState>
