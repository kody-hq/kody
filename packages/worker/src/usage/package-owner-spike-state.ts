import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const packageOwnerSpikeState = setup({
	schemas: {
		events: {
			REFRESH: types<{}>(),
			TRIGGER: types<{}>(),
			DELIVER: types<{}>(),
			REARM: types<{}>(),
		},
	},
}).createMachine({
	id: 'package_owner_error_spike.status',
	description:
		'Owners trigger pending delivery, become alerted after success, and rearm after health, inactivity or abandoned delivery; immediate delivery may persist alerted directly from ok.',
	initial: 'ok',
	states: {
		ok: {
			on: {
				REFRESH: { target: 'ok' },
				TRIGGER: { target: 'pending' },
				DELIVER: { target: 'alerted' },
			},
		},
		pending: {
			on: {
				REFRESH: { target: 'pending' },
				REARM: { target: 'ok' },
				DELIVER: { target: 'alerted' },
			},
		},
		alerted: {
			on: { REFRESH: { target: 'alerted' }, REARM: { target: 'ok' } },
		},
	},
})

export type PackageOwnerSpikeStateStatus = LifecycleStateOf<
	typeof packageOwnerSpikeState
>
