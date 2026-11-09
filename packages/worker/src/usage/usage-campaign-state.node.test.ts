import { expect, test } from 'vitest'
import {
	usageCampaignState,
	usageCampaignTags,
	usageCampaignPhases,
} from './usage-campaign-state.ts'

test('campaign replacement graph keeps the legacy persisted tag mapping', () => {
	expect(usageCampaignState.transitions).toEqual({
		verified_no_mcp: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
		connected_no_package: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
		packaged_single_client: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
		activated: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
		cooling: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
		limit_aware: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
		paid: [
			'verified_no_mcp',
			'connected_no_package',
			'packaged_single_client',
			'activated',
			'cooling',
			'limit_aware',
			'paid',
		],
	})
	expect(usageCampaignState.terminal).toEqual([])
	expect(Object.values(usageCampaignTags)).toEqual([
		'VerifiedNoMcp',
		'ConnectedNoPackage',
		'PackagedSingleClient',
		'Activated',
		'Cooling',
		'LimitAware',
		'Paid',
	])
	for (const phase of usageCampaignState.states)
		expect(usageCampaignPhases[usageCampaignTags[phase]]).toBe(phase)
	expect(usageCampaignState.is('Activated')).toBe(false)
})
