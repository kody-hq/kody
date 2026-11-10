import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const deviceAuthorizationState = setup({
	schemas: {
		events: { APPROVE: types<{}>(), DENY: types<{}>(), CONSUME: types<{}>() },
	},
}).createMachine({
	id: 'oauth_device_authorizations.status',
	description:
		'Device requests await a decision before an approved request can be consumed.',
	initial: 'pending',
	states: {
		pending: {
			on: { APPROVE: { target: 'approved' }, DENY: { target: 'denied' } },
		},
		approved: { on: { CONSUME: { target: 'consumed' } } },
		denied: { type: 'final' },
		consumed: { type: 'final' },
	},
})

export type DeviceAuthorizationStatus = LifecycleStateOf<
	typeof deviceAuthorizationState
>
