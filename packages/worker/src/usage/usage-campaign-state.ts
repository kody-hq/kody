import { defineStatusEnum } from '@kody-internal/shared/state-machine.ts'

export const usageCampaignState = defineStatusEnum({
	name: 'user_usage_campaigns.lifecycle',
	description:
		'Ledger phase replacements preserve legacy PascalCase stored tags via the exported mapping; evaluator activation and cooling history gates remain unchanged.',
	values: [
		'verified_no_mcp',
		'connected_no_package',
		'packaged_single_client',
		'activated',
		'cooling',
		'limit_aware',
		'paid',
	],
})

export const usageCampaignTags = {
	verified_no_mcp: 'VerifiedNoMcp',
	connected_no_package: 'ConnectedNoPackage',
	packaged_single_client: 'PackagedSingleClient',
	activated: 'Activated',
	cooling: 'Cooling',
	limit_aware: 'LimitAware',
	paid: 'Paid',
} as const satisfies Record<(typeof usageCampaignState.values)[number], string>
export type UsageCampaignState =
	(typeof usageCampaignTags)[(typeof usageCampaignState.values)[number]]
export const usageCampaignPhases = {
	VerifiedNoMcp: 'verified_no_mcp',
	ConnectedNoPackage: 'connected_no_package',
	PackagedSingleClient: 'packaged_single_client',
	Activated: 'activated',
	Cooling: 'cooling',
	LimitAware: 'limit_aware',
	Paid: 'paid',
} as const satisfies Record<
	UsageCampaignState,
	(typeof usageCampaignState.values)[number]
>
