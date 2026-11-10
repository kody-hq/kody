import { expect, test } from 'vitest'
import {
	usageCampaignState,
	usageCampaignTags,
	usageCampaignPhases,
} from './usage-campaign-state.ts'

test('campaign replacements stay open and round-trip the legacy persisted tags', () => {
	const persisted = [
		['verified_no_mcp', 'VerifiedNoMcp'],
		['connected_no_package', 'ConnectedNoPackage'],
		['packaged_single_client', 'PackagedSingleClient'],
		['activated', 'Activated'],
		['cooling', 'Cooling'],
		['limit_aware', 'LimitAware'],
		['paid', 'Paid'],
	] as const
	for (const [phase, tag] of persisted) {
		expect(usageCampaignState.parse(phase)).toBe(phase)
		expect(usageCampaignTags[phase]).toBe(tag)
		expect(usageCampaignPhases[tag]).toBe(phase)
		expect(usageCampaignState.is(tag)).toBe(false)
	}
	expect(() => usageCampaignState.parse('VerifiedNoMcp')).toThrow(
		'user_usage_campaigns.lifecycle',
	)
})
