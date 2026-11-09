import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const inviteLinkState = defineStateMachine({
	name: 'org_invite_links.status',
	description:
		'An active invite link can be explicitly revoked; expiry and exhaustion are derived eligibility conditions.',
	initial: 'active',
	transitions: { active: ['revoked'], revoked: [] },
})

export type OrgInviteLinkStatus = StateOf<typeof inviteLinkState>
