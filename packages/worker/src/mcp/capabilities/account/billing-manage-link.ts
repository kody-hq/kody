import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	orgBillingPageUrl,
	resolveBillingOrgAccess,
} from '#worker/billing/checkout-link.ts'

const runtimeCallerErrorMessage =
	'billingManageLink runs for a person or their agent. Call it from an interactive MCP session, execute, the Open API, or the kody CLI. Package app and job code cannot call it.'

export const billingManageLinkCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'billingManageLink',
		contextRuns: 'deny',
		// The handler checks `billing:write` itself so a caller without it gets
		// a plain reason in the result instead of a permission error.
		orgPermission: 'none',
		description:
			"Get the link to an organization's billing page, where a person changes or cancels a paid plan (manage a subscription, switch from a retired plan to current Pro, update billing). Returns a kody.codes URL to hand to the person. It starts no checkout and applies no promo: promos are for new subscriptions only, so use `billingCheckoutLink` for an organization on the Free plan. Returns ok: false with a plain reason when the caller cannot manage billing for the organization.",
		keywords: [
			'billing',
			'billing page',
			'manage billing',
			'manage subscription',
			'subscription',
			'change plan',
			'switch plan',
			'legacy plan',
			'cancel',
			'pro',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			org: z
				.string()
				.optional()
				.describe(
					'Handle of the organization, with or without @. Defaults to the organization this connection works for, and must be that organization.',
				),
		}),
		outputSchema: z.discriminatedUnion('ok', [
			z.object({
				ok: z.literal(true),
				url: z
					.string()
					.describe("The organization's billing page on kody.codes."),
				org: z.string(),
				message: z.string().describe('What to tell the person.'),
			}),
			z.object({
				ok: z.literal(false),
				reason: z
					.string()
					.describe('Why there is no link for this caller, in plain words.'),
			}),
		]),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			requireInteractiveMcpCaller(ctx.callerContext, runtimeCallerErrorMessage)
			const access = await resolveBillingOrgAccess({
				env: ctx.env,
				userId: user.userId,
				requestForOrg: (binding) =>
					binding.org.id === request.org.id ? request : null,
				org: args.org ?? request.org.slug,
			})
			if (!access.ok) return { ok: false as const, reason: access.reason }
			const { slug } = access
			return {
				ok: true as const,
				url: orgBillingPageUrl(slug, ctx.callerContext.baseUrl),
				org: slug,
				message: `Open this link to manage billing for @${slug}. To move from an older plan, switch to current Pro there.`,
			}
		},
	},
)
