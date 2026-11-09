import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inviteLinkState = setup({
	types: { events: {} as { type: 'REVOKE' } },
}).createMachine({
	id: 'org_invite_links.status',
	description:
		'An active invite link can be explicitly revoked; expiry and exhaustion are derived eligibility conditions.',
	initial: 'active',
	states: { active: { on: { REVOKE: 'revoked' } }, revoked: { type: 'final' } },
})

export type OrgInviteLinkStatus = LifecycleStateOf<typeof inviteLinkState>
