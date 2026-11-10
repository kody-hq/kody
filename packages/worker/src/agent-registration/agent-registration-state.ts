import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const agentRegistrationState = setup({
	schemas: {
		events: {
			CLAIM: types<{}>(),
			DENY: types<{}>(),
			CONSUME: types<{}>(),
			RESTORE: types<{}>(),
		},
	},
}).createMachine({
	id: 'agent_registrations.status',
	description:
		'Registrations await a claim decision, then consumption with retry rollback when token minting fails.',
	initial: 'pending',
	states: {
		pending: {
			on: { CLAIM: { target: 'claimed' }, DENY: { target: 'denied' } },
		},
		claimed: { on: { CONSUME: { target: 'consumed' } } },
		denied: { type: 'final' },
		consumed: { on: { RESTORE: { target: 'claimed' } } },
	},
})

export type AgentRegistrationStatus = LifecycleStateOf<
	typeof agentRegistrationState
>
