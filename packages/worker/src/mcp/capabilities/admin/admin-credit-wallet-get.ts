import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { loadAdminCreditWallet } from '#worker/admin/credit-grants.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminCreditTargetSchema,
	adminCreditWalletSchema,
} from './admin-credit-shared.ts'

export const adminCreditWalletGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminCreditWalletGet',
		contextRuns: 'deny',
		description:
			'Read one account’s prepaid credit wallet: balance, whether it is on the credit-eligible Pro plan, whether usage past the include runs on credits, and the 20 most recent ledger entries (top-ups, auto-refills, debits, and admin grants with the granting admin and note).',
		keywords: ['admin', 'credits', 'wallet', 'balance', 'ledger', 'audit'],
		inputSchema: adminCreditTargetSchema,
		outputSchema: adminCreditWalletSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCreditWalletGet',
				async () => {
					const wallet = await loadAdminCreditWallet(ctx.env, {
						stableUserId: args.stableUserId,
						email: args.email,
						username: args.username,
					})
					// Missing target is caller-supplied; keep off Sentry via McpCallerError.
					if (!wallet) throw new McpCallerError('User not found.')
					const { ok: _ok, ...rest } = wallet
					return rest
				},
				{
					successReason: (wallet) =>
						`target_stable_user_id=${wallet.stableUserId}`,
				},
			)
		},
	},
)
