import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { componentIncidentState } from './incident-state.ts'

test('a component probe flips between operational and down without self-loops', () => {
	expect(
		canHandle(componentIncidentState, 'operational', 'OPEN_INCIDENT'),
	).toBe(true)
	expect(canHandle(componentIncidentState, 'down', 'RESOLVE_INCIDENT')).toBe(
		true,
	)
	expect(
		canHandle(componentIncidentState, 'operational', 'RESOLVE_INCIDENT'),
	).toBe(false)
	expect(canHandle(componentIncidentState, 'down', 'OPEN_INCIDENT')).toBe(false)
})
