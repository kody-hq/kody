import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const deviceAuthorizationState = defineStateMachine({
	name: 'oauth_device_authorizations.status',
	description:
		'Device requests await a decision before an approved request can be consumed.',
	initial: 'pending',
	transitions: {
		pending: ['approved', 'denied'],
		approved: ['consumed'],
		denied: [],
		consumed: [],
	},
})

export type DeviceAuthorizationStatus = StateOf<typeof deviceAuthorizationState>
