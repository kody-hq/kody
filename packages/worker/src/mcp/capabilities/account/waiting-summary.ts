import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { deriveWaitingItemsForStableUser } from '#mcp/waiting/derive-waiting.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { waitingItemKinds, waitingSeverities } from '#universal/waiting.ts'

const waitingItemSchema = z.object({
	id: z.string(),
	kind: z.enum(waitingItemKinds),
	title: z.string(),
	why: z.string(),
	who: z.literal('you'),
	do_label: z.string(),
	href: z.string(),
	severity: z.enum(waitingSeverities),
})

export const waitingSummaryCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'waitingSummary',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'List things currently waiting on the signed-in human: email verification, OAuth reconnects, your own paused automations (enablements whose run lost access it needs), expired secrets, MCP reconnects, locked-package publishes, plan caps, wizard resume, first-use setup (search, memory, execute, package, job, integration, secret, Discord membership), and an elevated open-error rate that still needs Activity triage. Ignored and resolved Activity errors do not keep that card around. This is a current-state queue, not run history — use runSummary for Activity. Vendor outages do not appear here.',
		keywords: [
			'waiting',
			'inbox',
			'approvals',
			'blockers',
			'reconnect',
			'needs you',
			'onboarding',
			'first use',
			'discord',
			'verify email',
			'locked package',
			'MCP disconnected',
			'expired secret',
			'paused',
			'enablement',
			'oauth',
			'integration',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			count: z.number().int().nonnegative(),
			waiting_url: z.string(),
			items: z.array(waitingItemSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const origin = ctx.callerContext.baseUrl.replace(/\/+$/, '')
			const items = await deriveWaitingItemsForStableUser({
				env: ctx.env,
				personId: user.userId,
				orgId: ctx.callerContext.request?.org.id ?? null,
				email: user.email,
				waitUntil: ctx.waitUntil,
			})
			const orgSlug =
				ctx.callerContext.request?.org.slug?.trim() ||
				user.username?.trim() ||
				''
			return {
				count: items.length,
				waiting_url: orgSlug
					? `${origin}${orgResourcePath(orgSlug, 'waiting')}`
					: `${origin}/account`,
				items: items.map((item) => ({
					id: item.id,
					kind: item.kind,
					title: item.title,
					why: item.why,
					who: item.who,
					do_label: item.doLabel,
					href: item.href.startsWith('http')
						? item.href
						: `${origin}${item.href}`,
					severity: item.severity,
				})),
			}
		},
	},
)
