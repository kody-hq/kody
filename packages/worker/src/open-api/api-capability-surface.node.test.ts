import { expect, test } from 'vitest'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import {
	capabilityApiAvailabilitySummary,
	isCapabilityAvailableViaApiTool,
} from './api-capability-surface.ts'
import { apiOperationsById } from './operations.ts'

test('search and api agree on which capabilities api can call', async () => {
	const registry = await getStaticRegistry()
	const executeOnlySamples = [
		'webhookSyntheticDispatch',
		'adminPlatformFeedbackGet',
	]
	for (const name of executeOnlySamples) {
		expect(registry.capabilitySpecs[name]).toBeTruthy()
		expect(isCapabilityAvailableViaApiTool(name)).toBe(false)
		expect(apiOperationsById.has(name)).toBe(false)
		expect(capabilityApiAvailabilitySummary(name).apiAvailable).toBe(false)
		expect(capabilityApiAvailabilitySummary(name).summary).toContain(
			'execute-only',
		)
	}
	expect(registry.capabilitySpecs.execute).toBeTruthy()
	expect(isCapabilityAvailableViaApiTool('execute')).toBe(false)
	expect(apiOperationsById.get('execute')?.kind).toBe('native')
	expect(capabilityApiAvailabilitySummary('execute').apiAvailable).toBe(false)

	expect(isCapabilityAvailableViaApiTool('webhookDeliveryList')).toBe(true)
	expect(isCapabilityAvailableViaApiTool('metaGetCurrentUser')).toBe(true)
	expect(isCapabilityAvailableViaApiTool('packageAppFetch')).toBe(true)
	expect(
		capabilityApiAvailabilitySummary('metaGetCurrentUser').summary,
	).toContain('operationId')
})
