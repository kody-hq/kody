import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageOwnerSpikeState = setup({
	types: {
		events: {} as
			| { type: 'REFRESH' }
			| { type: 'TRIGGER' }
			| { type: 'DELIVER' }
			| { type: 'REARM' },
	},
}).createMachine({
	id: 'package_owner_error_spike.status',
	description:
		'Owners trigger pending delivery, become alerted after success, and rearm after health, inactivity or abandoned delivery; immediate delivery may persist alerted directly from ok.',
	initial: 'ok',
	states: {
		ok: { on: { REFRESH: 'ok', TRIGGER: 'pending', DELIVER: 'alerted' } },
		pending: { on: { REFRESH: 'pending', REARM: 'ok', DELIVER: 'alerted' } },
		alerted: { on: { REFRESH: 'alerted', REARM: 'ok' } },
	},
})

export type PackageOwnerSpikeStateStatus = LifecycleStateOf<
	typeof packageOwnerSpikeState
>
