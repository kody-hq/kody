import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const agentRegistrationState = setup({
	types: {
		events: {} as
			| { type: 'CLAIM' }
			| { type: 'DENY' }
			| { type: 'CONSUME' }
			| { type: 'RESTORE' },
	},
}).createMachine({
	id: 'agent_registrations.status',
	description:
		'Registrations await a claim decision, then consumption with retry rollback when token minting fails.',
	initial: 'pending',
	states: {
		pending: { on: { CLAIM: 'claimed', DENY: 'denied' } },
		claimed: { on: { CONSUME: 'consumed' } },
		denied: { type: 'final' },
		consumed: { on: { RESTORE: 'claimed' } },
	},
})

export type AgentRegistrationStatus = LifecycleStateOf<
	typeof agentRegistrationState
>
