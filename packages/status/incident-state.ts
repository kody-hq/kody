import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const componentIncidentState = defineStateMachine({
	name: 'component_probe.status',
	description:
		'Consecutive failure and recovery thresholds move a component between operational and down.',
	initial: 'operational',
	transitions: { operational: ['down'], down: ['operational'] },
})

export type ComponentIncidentStatus = StateOf<typeof componentIncidentState>
