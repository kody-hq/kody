import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inviteState = setup({
	schemas: {
		events: { ACCEPT: types<{}>(), REVOKE: types<{}>(), EXPIRE: types<{}>() },
	},
}).createMachine({
	id: 'invites.status',
	description:
		'Pending invitations close through acceptance, revocation, recipient decline or expiry.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				ACCEPT: { target: 'accepted' },
				REVOKE: { target: 'revoked' },
				EXPIRE: { target: 'expired' },
			},
		},
		accepted: { type: 'final' },
		revoked: { type: 'final' },
		expired: { type: 'final' },
	},
})

export type InviteStatus = LifecycleStateOf<typeof inviteState>
