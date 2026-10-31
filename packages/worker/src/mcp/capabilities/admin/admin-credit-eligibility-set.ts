import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { creditAdminGrantNoteMaxLength } from '#universal/credits.ts'
import {
	AdminCreditGrantError,
	formatAdminCreditEligibilityAuditReason,
	loadAdminCreditWallet,
} from '#worker/admin/credit-grants.ts'
import {
	AdminOrgBillingMutationError,
	setAdminOrgCreditEligibility,
} from '#worker/admin/org-billing-mutations.ts'
import { orgLimitOverrideReasonMaxLength } from '#worker/admin/org-limit-overrides.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	legacyAuditWriter,
	legacyReason,
	resolveLegacyPersonalOrg,
} from './admin-legacy-billing.ts'
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
		reason: z
			.string()
			.trim()
			.max(orgLimitOverrideReasonMaxLength)
			.optional()
			.describe('Why eligibility changed. Defaults to the legacy note.'),
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
			'Deprecated: use adminOrgCreditEligibilitySet with an org handle. Turn admin prepaid-credit eligibility on or off for one account by stable user id, email, or username (users.admin_credits_eligible). Stripe refreshes never overwrite it. With an effective Pro plan (for example a manual adminUserUpdate plan grant), eligibility gives the account the same credit wallet as the purchasable Pro subscription: usage past the Pro include runs on credits and debits the wallet, and stops at the include when the balance runs out. Turning it off leaves the balance on hold. Does not create Stripe customers or subscriptions, and does not enable buying credits or auto-refill. Audited, with an optional note. Use adminOrgCreditEligibilitySet to change eligibility for any organization.',
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
			const reason = legacyReason(
				'adminCreditEligibilitySet',
				args.reason,
				args.note,
			)
			const note = args.note?.trim() || null
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCreditEligibilitySet',
				async () => {
					try {
						const { user, orgId } = await resolveLegacyPersonalOrg(ctx, args)
						const { audit } = await legacyAuditWriter(ctx)
						const result = await setAdminOrgCreditEligibility({
							env: ctx.env,
							audit,
							target: { orgId },
							creditsEligible: args.creditsEligible,
							reason,
							platformAudit: false,
						})
						const wallet = await loadAdminCreditWallet(ctx.env, {
							stableUserId: user.stableUserId,
						})
						if (!wallet) throw new McpCallerError('User not found.')
						const { ok: _ok, ...legacyWallet } = wallet
						return {
							previousAdminCreditsEligible: result.previous,
							wallet: legacyWallet,
						}
					} catch (error) {
						if (
							error instanceof AdminCreditGrantError ||
							error instanceof AdminOrgBillingMutationError
						) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: (result) =>
						`${formatAdminCreditEligibilityAuditReason({
							stableUserId: result.wallet.stableUserId,
							creditsEligible: args.creditsEligible,
							previousAdminCreditsEligible: result.previousAdminCreditsEligible,
							note,
						})};reason=${reason}`,
				},
			)
		},
	},
)
