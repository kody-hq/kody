import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const referralState = defineStateMachine({
	name: 'referrals.status',
	description:
		'Pending referrals reject fraud or reward qualifying invoices; incomplete reward delivery may retry.',
	initial: 'pending',
	transitions: {
		pending: ['rejected', 'rewarded'],
		rewarded: ['rewarded'],
		rejected: [],
	},
})

export type ReferralStatus = StateOf<typeof referralState>
