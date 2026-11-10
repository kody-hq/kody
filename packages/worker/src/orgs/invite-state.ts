import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inviteState = setup({
	types: {
		events: {} as { type: 'ACCEPT' } | { type: 'REVOKE' } | { type: 'EXPIRE' },
	},
}).createMachine({
	id: 'invites.status',
	description:
		'Pending invitations close through acceptance, revocation, recipient decline or expiry.',
	initial: 'pending',
	states: {
		pending: {
			on: { ACCEPT: 'accepted', REVOKE: 'revoked', EXPIRE: 'expired' },
		},
		accepted: { type: 'final' },
		revoked: { type: 'final' },
		expired: { type: 'final' },
	},
})

export type InviteStatus = LifecycleStateOf<typeof inviteState>
