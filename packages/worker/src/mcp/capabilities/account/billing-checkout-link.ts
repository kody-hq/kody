import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	checkoutLinkPath,
	evaluateCheckoutLink,
} from '#worker/billing/checkout-link.ts'

const runtimeCallerErrorMessage =
	'billingCheckoutLink runs for a person or their agent. Call it from an interactive MCP session, execute, the Open API, or the kody CLI. Package app and job code cannot call it.'

export const billingCheckoutLinkCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'billingCheckoutLink',
		contextRuns: 'deny',
		// The handler checks `billing:write` itself so a caller without it gets
		// a plain reason in the result instead of a permission error.
		orgPermission: 'none',
		description:
			'Get a checkout link a person opens to upgrade an organization to Pro (start checkout, subscribe, apply a coupon or sale discount). Returns a kody.codes URL, never a payment page: hand it to the person. When they open it, Kody checks they are signed in and can manage billing for the organization, applies any running sale price they qualify for, and sends them to Stripe to pay. You cannot pay for them, and nothing is charged until they finish. Returns ok: false with a plain reason when checkout does not apply (already on a paid plan, no billing access, unknown organization, invalid plan or interval). `offer` says whether a running sale price will apply; when it will not, the link still works at the regular price.',
		keywords: [
			'billing',
			'checkout',
			'checkout link',
			'upgrade',
			'subscribe',
			'pro',
			'plan',
			'coupon',
			'promo',
			'discount',
			'sale',
			'pay',
			'purchase',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			org: z
				.string()
				.optional()
				.describe(
					'Handle of the organization to upgrade, with or without @. Defaults to the organization this connection works for, and must be that organization.',
				),
			plan: z
				.string()
				.optional()
				.describe('The plan to buy. Only "pro" is sold at checkout (default).'),
			interval: z.string().optional().describe('"month" (default) or "year".'),
		}),
		outputSchema: z.discriminatedUnion('ok', [
			z.object({
				ok: z.literal(true),
				url: z
					.string()
					.describe(
						'The kody.codes link to give the person. It does not expire and is safe to forward: every check runs again for whoever opens it.',
					),
				org: z.string(),
				plan: z.literal('pro'),
				interval: z.enum(['month', 'year']),
				offer: z
					.object({
						applies: z.boolean(),
						message: z
							.string()
							.describe(
								'The sale price the person will get, or why the sale price will not apply to them.',
							),
					})
					.nullable()
					.describe('A running sale, or null when there is none.'),
				message: z.string().describe('What to tell the person.'),
			}),
			z.object({
				ok: z.literal(false),
				reason: z
					.string()
					.describe('Why checkout does not apply, in plain words.'),
			}),
		]),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			requireInteractiveMcpCaller(ctx.callerContext, runtimeCallerErrorMessage)
			const decision = await evaluateCheckoutLink({
				env: ctx.env,
				userId: user.userId,
				requestForOrg: (binding) =>
					binding.org.id === request.org.id ? request : null,
				org: args.org ?? request.org.slug,
				plan: args.plan ?? 'pro',
				interval: args.interval ?? 'month',
				now: new Date(),
			})
			if (!decision.ok) return { ok: false as const, reason: decision.reason }
			const url = new URL(
				checkoutLinkPath({
					orgSlug: decision.org.slug,
					interval: decision.interval,
				}),
				ctx.callerContext.baseUrl,
			).toString()
			const offer = decision.offer
				? {
						applies: decision.offer.applies,
						message: decision.offer.applies
							? decision.offer.summary
							: decision.offer.reason,
					}
				: null
			return {
				ok: true as const,
				url,
				org: decision.org.slug,
				plan: decision.plan,
				interval: decision.interval,
				offer,
				message: [
					`Open this link to check out Pro for @${decision.org.slug}. You sign in, confirm, and pay on Stripe.`,
					offer?.applies
						? offer.message
						: offer
							? `${offer.message} Checkout is at the regular price.`
							: null,
				]
					.filter(Boolean)
					.join(' '),
			}
		},
	},
)
