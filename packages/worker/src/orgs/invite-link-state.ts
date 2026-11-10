import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inviteLinkState = setup({
	schemas: { events: { REVOKE: types<{}>() } },
}).createMachine({
	id: 'org_invite_links.status',
	description:
		'An active invite link can be explicitly revoked; expiry and exhaustion are derived eligibility conditions.',
	initial: 'active',
	states: {
		active: { on: { REVOKE: { target: 'revoked' } } },
		revoked: { type: 'final' },
	},
})

export type OrgInviteLinkStatus = LifecycleStateOf<typeof inviteLinkState>
