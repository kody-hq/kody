import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const deviceAuthorizationState = setup({
	types: {
		events: {} as { type: 'APPROVE' } | { type: 'DENY' } | { type: 'CONSUME' },
	},
}).createMachine({
	id: 'oauth_device_authorizations.status',
	description:
		'Device requests await a decision before an approved request can be consumed.',
	initial: 'pending',
	states: {
		pending: { on: { APPROVE: 'approved', DENY: 'denied' } },
		approved: { on: { CONSUME: 'consumed' } },
		denied: { type: 'final' },
		consumed: { type: 'final' },
	},
})

export type DeviceAuthorizationStatus = LifecycleStateOf<
	typeof deviceAuthorizationState
>
