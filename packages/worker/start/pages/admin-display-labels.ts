import { type AccountCreditsLedgerItem } from '#universal/loader-data.ts'

export function formatAdminCreditLedgerKind(
	kind: AccountCreditsLedgerItem['kind'],
) {
	return {
		top_up: 'Top-up',
		auto_refill: 'Auto-refill',
		admin_grant: 'Admin grant',
		debit: 'Debit',
	}[kind]
}

export function formatAdminEntitlementLadder(ladder: 'public' | 'legacy') {
	return ladder === 'legacy' ? 'Legacy' : 'Public'
}

export function formatAdminOrganizationRole(
	role: 'owner' | 'member' | 'billing',
) {
	return role === 'owner' ? 'Owner' : role === 'billing' ? 'Billing' : 'Member'
}

export function formatAdminPlanLabel(plan: string) {
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}
