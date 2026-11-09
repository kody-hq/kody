import {
	canHandle,
	finalStatesOf,
	isState,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { inviteLinkState } from './invite-link-state.ts'

test('invite links revoke permanently; expiry is not a stored status', () => {
	expect(canHandle(inviteLinkState, 'active', 'REVOKE')).toBe(true)
	expect(finalStatesOf(inviteLinkState).includes('revoked')).toBe(true)
	expect(canHandle(inviteLinkState, 'revoked', 'CREATE' as never)).toBe(false)
	expect(isState(inviteLinkState, 'expired')).toBe(false)
	expect(isState(inviteLinkState, 'exhausted')).toBe(false)
})
