import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const componentIncidentState = setup({
	types: {
		events: {} as { type: 'OPEN_INCIDENT' } | { type: 'RESOLVE_INCIDENT' },
	},
}).createMachine({
	id: 'component_probe.status',
	description:
		'Consecutive failure and recovery thresholds move a component between operational and down.',
	initial: 'operational',
	states: {
		operational: { on: { OPEN_INCIDENT: 'down' } },
		down: { on: { RESOLVE_INCIDENT: 'operational' } },
	},
})

export type ComponentIncidentStatus = LifecycleStateOf<
	typeof componentIncidentState
>
