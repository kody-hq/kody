import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const connectOauthStepState = defineStateMachine({
	name: 'connect_oauth.step',
	description:
		'Client setup advances to browser or device authorization, callbacks can repair credentials, and only success carries a saved-token receipt.',
	initial: ['setup', 'connect'],
	transitions: {
		setup: ['setup', 'connect', 'callback'],
		connect: ['connect', 'setup', 'device', 'callback'],
		device: ['device', 'connect', 'success'],
		callback: ['callback', 'setup', 'connect', 'success'],
		success: ['success', 'setup'],
	},
})
export const connectOauthOperationState = defineStateMachine({
	name: 'connect_oauth.operation',
	description:
		'One setup or authorize request fences submission independently of the displayed OAuth step and its feedback.',
	initial: 'idle',
	transitions: { idle: ['submitting'], submitting: ['idle'] },
})
export type ConnectOauthStep = StateOf<typeof connectOauthStepState>
