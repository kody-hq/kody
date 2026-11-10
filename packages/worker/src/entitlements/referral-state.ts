import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const referralState = setup({
	types: {
		events: {} as { type: 'REJECT_FRAUD' } | { type: 'REWARD' },
	},
}).createMachine({
	id: 'referrals.status',
	description:
		'Pending referrals reject fraud or reward qualifying invoices; incomplete reward delivery may retry, but rejected referrals cannot be rewarded.',
	initial: 'pending',
	states: {
		pending: { on: { REJECT_FRAUD: 'rejected', REWARD: 'rewarded' } },
		rewarded: { on: { REWARD: 'rewarded' } },
		rejected: { type: 'final' },
	},
})

export type ReferralStatus = LifecycleStateOf<typeof referralState>
