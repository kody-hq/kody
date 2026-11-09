import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const emailClaimState = defineStateMachine({
	name: 'user_email_claims.status',
	description:
		'Email addresses can be claimed, released and reclaimed; either state may be inserted.',
	initial: ['claimed', 'released'],
	transitions: { claimed: ['released'], released: ['claimed'] },
})

export type EmailClaimStatus = StateOf<typeof emailClaimState>
