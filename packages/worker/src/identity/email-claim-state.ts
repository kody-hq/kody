import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const emailClaimState = setup({
	schemas: { events: { RELEASE: types<{}>(), CLAIM: types<{}>() } },
}).createMachine({
	id: 'user_email_claims.status',
	description:
		'Email addresses can be claimed, released and reclaimed; either state may be inserted. Rows or initial responses may enter directly in another listed state.',
	initial: 'claimed',
	states: {
		claimed: { on: { RELEASE: { target: 'released' } } },
		released: { on: { CLAIM: { target: 'claimed' } } },
	},
})

export type EmailClaimStatus = LifecycleStateOf<typeof emailClaimState>
