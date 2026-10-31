import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	creditAdminGrantMaxCents,
	creditAdminGrantNoteMaxLength,
} from '#universal/credits.ts'
import {
	AdminCreditGrantError,
	formatAdminCreditGrantAuditReason,
	loadAdminCreditWallet,
} from '#worker/admin/credit-grants.ts'
import {
	AdminOrgBillingMutationError,
	grantAdminCreditsToOrg,
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
		amountCents: z
			.number()
			.int()
			.min(1)
			.max(creditAdminGrantMaxCents)
			.describe('Credits to add, in whole US cents (1000 = $10).'),
		note: z
			.string()
			.max(creditAdminGrantNoteMaxLength)
			.optional()
			.describe('Why the grant was made. Stored on the ledger entry.'),
		reason: z
			.string()
			.trim()
			.max(orgLimitOverrideReasonMaxLength)
			.optional()
			.describe('Why the grant was made. Defaults to the legacy note.'),
	}),
)

const outputSchema = z.object({
	entryId: z.string(),
	amountCents: z.number().int(),
	wallet: adminCreditWalletSchema,
})

export const adminCreditGrantCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminCreditGrant',
		contextRuns: 'deny',
		description:
			'Deprecated: use adminOrgCreditGrant with an org handle. Grant (add) prepaid credits to one account by stable user id, email, or username, including the calling admin. House-funded: no Stripe charge. Writes an audited ledger entry with the granting admin, amount, recipient, time, and optional note. Credits are only spent (on usage past the Pro include) by credit-eligible Pro accounts; otherwise the balance is held. Use adminOrgCreditGrant to grant credits to any organization wallet.',
		keywords: ['admin', 'credits', 'wallet', 'grant', 'balance', 'top up'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const reason = legacyReason('adminCreditGrant', args.reason, args.note)
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCreditGrant',
				async () => {
					try {
						const { user, orgId } = await resolveLegacyPersonalOrg(ctx, args)
						const { admin, audit } = await legacyAuditWriter(ctx)
						const result = await grantAdminCreditsToOrg({
							env: ctx.env,
							audit,
							target: { orgId },
							grantedBy: {
								stableUserId: admin.stableUserId,
								email: admin.email,
							},
							amountCents: args.amountCents,
							reason,
							platformAudit: false,
						})
						const wallet = await loadAdminCreditWallet(ctx.env, {
							stableUserId: user.stableUserId,
						})
						if (!wallet) throw new McpCallerError('User not found.')
						const { ok: _ok, ...legacyWallet } = wallet
						return {
							entryId: result.entryId,
							amountCents: result.amountCents,
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
						`${formatAdminCreditGrantAuditReason({
							stableUserId: result.wallet.stableUserId,
							amountCents: result.amountCents,
							entryId: result.entryId,
						})};reason=${reason}`,
				},
			)
		},
	},
)
