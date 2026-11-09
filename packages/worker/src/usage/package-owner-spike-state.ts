import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const packageOwnerSpikeState = defineStateMachine({
	name: 'package_owner_error_spike.status',
	description:
		'Owners trigger pending delivery, become alerted after success, and rearm after health, inactivity or abandoned delivery; immediate delivery may persist alerted directly from ok.',
	initial: 'ok',
	transitions: {
		ok: ['ok', 'pending', 'alerted'],
		pending: ['pending', 'ok', 'alerted'],
		alerted: ['alerted', 'ok'],
	},
})

export type PackageOwnerSpikeStateStatus = StateOf<
	typeof packageOwnerSpikeState
>
