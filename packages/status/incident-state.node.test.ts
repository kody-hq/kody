import { expect, test } from 'vitest'
import { componentIncidentState } from './incident-state.ts'

test('a component probe flips between operational and down without self-loops', () => {
	expect(componentIncidentState.can('operational', 'down')).toBe(true)
	expect(componentIncidentState.can('down', 'operational')).toBe(true)
	expect(componentIncidentState.can('operational', 'operational')).toBe(false)
	expect(componentIncidentState.can('down', 'down')).toBe(false)
})
