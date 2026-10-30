import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { creditAdminGrantNoteMaxLength } from '#universal/credits.ts'
import {
	AdminCreditGrantError,
	formatAdminCreditEligibilityAuditReason,
	setAdminCreditEligibility,
} from '#worker/admin/credit-grants.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminCreditTargetSchema,
	adminCreditWalletSchema,
} from './admin-credit-shared.ts'

const inputSchema = z.intersection(
	adminCreditTargetSchema,
	z.object({
		creditsEligible: z
			.boolean()
			.describe(
				'True turns on admin credit eligibility; false clears it (the balance stays on hold).',
			),
		note: z
			.string()
			.max(creditAdminGrantNoteMaxLength)
			.optional()
			.describe('Why eligibility changed. Stored on the admin audit event.'),
	}),
)

const outputSchema = z.object({
	previousAdminCreditsEligible: z.boolean(),
	wallet: adminCreditWalletSchema,
})

export const adminCreditEligibilitySetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminCreditEligibilitySet',
		contextRuns: 'deny',
		description:
			'Turn admin prepaid-credit eligibility on or off for one account by stable user id, email, or username (users.admin_credits_eligible). Stripe refreshes never overwrite it. With an effective Pro plan (for example a manual adminUserUpdate plan grant), eligibility gives the account the same credit wallet as the purchasable Pro subscription: usage past the Pro include runs on credits and debits the wallet, and stops at the include when the balance runs out. Turning it off leaves the balance on hold. Does not create Stripe customers or subscriptions, and does not enable buying credits or auto-refill. Audited, with an optional note. Use adminOrgCreditEligibilitySet to change eligibility for any organization.',
		keywords: [
			'admin',
			'credits',
			'wallet',
			'eligible',
			'eligibility',
			'unlock',
			'pro',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			let note: string | null = null
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCreditEligibilitySet',
				async () => {
					try {
						const result = await setAdminCreditEligibility({
							env: ctx.env,
							target: {
								stableUserId: args.stableUserId,
								email: args.email,
								username: args.username,
							},
							creditsEligible: args.creditsEligible,
							note: args.note,
						})
						note = result.note
						const { ok: _ok, ...wallet } = result.wallet
						return {
							previousAdminCreditsEligible: result.previousAdminCreditsEligible,
							wallet,
						}
					} catch (error) {
						// Missing targets and bad note input are caller-clearable.
						if (error instanceof AdminCreditGrantError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: (result) =>
						formatAdminCreditEligibilityAuditReason({
							stableUserId: result.wallet.stableUserId,
							creditsEligible: args.creditsEligible,
							previousAdminCreditsEligible: result.previousAdminCreditsEligible,
							note,
						}),
				},
			)
		},
	},
)
