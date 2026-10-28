import type { AdminPlanName } from '#universal/loader-data.ts'
import type { CreditWalletState } from '#universal/plans.ts'

type CreditsAction = {
	label: 'Add credits' | 'Switch to Pro' | 'Manage credits'
	href: string
}

/** Where a capped account goes next; funded wallets and operator plans need nothing. */
export function creditsActionForWallet(
	creditWallet: CreditWalletState,
	plan: AdminPlanName,
	canBuyCredits: boolean,
	creditsHref: string,
): CreditsAction | null {
	switch (creditWallet) {
		case 'funded':
			return null
		case 'empty':
			return {
				/**
				 * Empty Pro wallets without self-serve top-up (for example an
				 * admin grant) open the Credits section instead of implying they
				 * must subscribe for Pro they may already have.
				 */
				label: canBuyCredits ? 'Add credits' : 'Manage credits',
				href: creditsHref,
			}
		case 'none':
			return plan === 'max'
				? null
				: { label: 'Switch to Pro', href: creditsHref }
		default: {
			const exhaustive: never = creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}
