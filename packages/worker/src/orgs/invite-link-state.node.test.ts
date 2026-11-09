import { expect, test } from 'vitest'
import { inviteLinkState } from './invite-link-state.ts'

test('invite links revoke permanently; expiry is not a stored status', () => {
	expect(inviteLinkState.can('active', 'revoked')).toBe(true)
	expect(inviteLinkState.isTerminal('revoked')).toBe(true)
	expect(inviteLinkState.can('revoked', 'active')).toBe(false)
	expect(inviteLinkState.is('expired')).toBe(false)
	expect(inviteLinkState.is('exhausted')).toBe(false)
})
