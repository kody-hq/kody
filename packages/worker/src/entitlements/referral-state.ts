import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const referralState = setup({
	types: {
		events: {} as
			| { type: 'REJECT_FRAUD' }
			| { type: 'REWARD'; creditsPending?: boolean },
	},
	guards: {
		creditsPending: ({ event }) =>
			event.type === 'REWARD' && event.creditsPending === true,
	},
}).createMachine({
	id: 'referrals.status',
	description:
		'Pending referrals reject fraud or reward qualifying invoices; incomplete reward delivery may retry. Existing reward SQL also rewrites rejected rows when their credit marker is unset, despite preflight rejection.',
	initial: 'pending',
	states: {
		pending: { on: { REJECT_FRAUD: 'rejected', REWARD: 'rewarded' } },
		rewarded: { on: { REWARD: 'rewarded' } },
		rejected: {
			on: { REWARD: { target: 'rewarded', guard: 'creditsPending' } },
		},
	},
})

export type ReferralStatus = LifecycleStateOf<typeof referralState>
