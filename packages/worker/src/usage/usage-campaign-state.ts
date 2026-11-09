import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const usageCampaignState = defineStateMachine({
	name: 'user_usage_campaigns.lifecycle',
	description:
		'Ledger phase replacements preserve legacy PascalCase stored tags via the exported mapping; evaluator activation and cooling history gates remain unchanged.',
	initial: [
		'verified_no_mcp',
		'connected_no_package',
		'packaged_single_client',
		'activated',
		'cooling',
		'limit_aware',
		'paid',
	],
	transitions: {
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
	},
})

export const usageCampaignTags = {
	verified_no_mcp: 'VerifiedNoMcp',
	connected_no_package: 'ConnectedNoPackage',
	packaged_single_client: 'PackagedSingleClient',
	activated: 'Activated',
	cooling: 'Cooling',
	limit_aware: 'LimitAware',
	paid: 'Paid',
} as const satisfies Record<StateOf<typeof usageCampaignState>, string>
export type UsageCampaignState = (typeof usageCampaignTags)[StateOf<
	typeof usageCampaignState
>]
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
	StateOf<typeof usageCampaignState>
>
