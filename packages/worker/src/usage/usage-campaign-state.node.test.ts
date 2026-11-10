import { expect, test } from 'vitest'
import {
	usageCampaignState,
	usageCampaignTags,
	usageCampaignPhases,
} from './usage-campaign-state.ts'

test('campaign replacements stay open and round-trip the legacy persisted tags', () => {
	for (const from of usageCampaignState.values)
		for (const to of usageCampaignState.values)
			expect(
				usageCampaignState.is(from) && usageCampaignState.is(to),
				`${from} -> ${to}`,
			).toBe(true)
	expect(usageCampaignTags).toEqual({
		verified_no_mcp: 'VerifiedNoMcp',
		connected_no_package: 'ConnectedNoPackage',
		packaged_single_client: 'PackagedSingleClient',
		activated: 'Activated',
		cooling: 'Cooling',
		limit_aware: 'LimitAware',
		paid: 'Paid',
	})
	for (const phase of usageCampaignState.values) {
		const tag = usageCampaignTags[phase]
		expect(usageCampaignState.is(tag)).toBe(false)
		expect(usageCampaignPhases[tag]).toBe(phase)
	}
})
