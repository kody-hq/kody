import { expect, test } from 'vitest'
import { inviteLinkState } from './invite-link-state.ts'

test('org_invite_links.status preserves the lifecycle graph', () => {
	expect(inviteLinkState.initial).toEqual(['active'])
	expect(inviteLinkState.transitions).toEqual({
		active: ['revoked'],
		revoked: [],
	})
	expect(inviteLinkState.terminal).toEqual(['revoked'])
})
