import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const inviteState = defineStateMachine({
	name: 'invites.status',
	description:
		'Pending invitations close through acceptance, revocation, recipient decline or expiry.',
	initial: 'pending',
	transitions: {
		pending: ['accepted', 'revoked', 'expired'],
		accepted: [],
		revoked: [],
		expired: [],
	},
})

export type InviteStatus = StateOf<typeof inviteState>
