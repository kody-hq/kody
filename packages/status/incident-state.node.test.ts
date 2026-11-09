import { expect, test } from 'vitest'
import { componentIncidentState } from './incident-state.ts'

test('component_probe.status preserves the lifecycle graph', () => {
	expect(componentIncidentState.initial).toEqual(['operational'])
	expect(componentIncidentState.transitions).toEqual({
		operational: ['down'],
		down: ['operational'],
	})
	expect(componentIncidentState.terminal).toEqual([])
})
