import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const agentRegistrationState = defineStateMachine({
	name: 'agent_registrations.status',
	description:
		'Registrations await a claim decision, then consumption with retry rollback when token minting fails.',
	initial: 'pending',
	transitions: {
		pending: ['claimed', 'denied'],
		claimed: ['consumed'],
		denied: [],
		consumed: ['claimed'],
	},
})

export type AgentRegistrationStatus = StateOf<typeof agentRegistrationState>
