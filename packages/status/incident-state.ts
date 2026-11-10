import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const componentIncidentState = setup({
	schemas: {
		events: { OPEN_INCIDENT: types<{}>(), RESOLVE_INCIDENT: types<{}>() },
	},
}).createMachine({
	id: 'component_probe.status',
	description:
		'Consecutive failure and recovery thresholds move a component between operational and down.',
	initial: 'operational',
	states: {
		operational: { on: { OPEN_INCIDENT: { target: 'down' } } },
		down: { on: { RESOLVE_INCIDENT: { target: 'operational' } } },
	},
})

export type ComponentIncidentStatus = LifecycleStateOf<
	typeof componentIncidentState
>
