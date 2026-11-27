import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import {
	authorize,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadOrgSessionAnalyticsState } from '#worker/session-analytics/consent.ts'
import {
	deleteSessionInsights,
	loadPackageSessionInsights,
	loadSessionInsights,
	type SessionInsightsOwner,
} from '#worker/session-analytics/insights.ts'
import {
	sessionAnalyticsStates,
	sessionInsightsScopes,
	sessionOutcomes,
	sessionStuckKinds,
	type SessionInsightsScope,
} from '#universal/session-analytics.ts'

const scopeSchema = z
	.enum(sessionInsightsScopes)
	.describe(
		'mine: only your own sessions in this organization. org: every member combined, with no per-member breakdown (Owners and Admins only).',
	)

type CapabilityContext = {
	env: Env
	callerContext: Parameters<typeof requireMcpRequest>[0]
}

async function ownerFor(
	ctx: CapabilityContext,
	scope: SessionInsightsScope,
): Promise<SessionInsightsOwner> {
	const request = requireMcpRequest(ctx.callerContext)
	if (scope === 'org') {
		await authorize({ env: ctx.env, request }, 'org:write')
		return { orgId: request.org.id }
	}
	if (!request.actor) {
		throw new McpCallerError(
			'Your own session insights need a signed-in person.',
		)
	}
	return { orgId: request.org.id, userId: request.actor.userId }
}

const entrySchema = z.object({
	category_id: z.string(),
	category: z.string(),
	outcome: z.enum(sessionOutcomes),
	stuck_kind: z.enum(sessionStuckKinds).nullable(),
	stuck_tool: z.string().nullable(),
	sessions: z.number(),
	calls: z.number(),
	errors: z.number(),
})

export const sessionInsightsGetCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'sessionInsightsGet',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description:
			'Read session analytics for the organization this request is bound to: whether it is turned on, and the same insights Kody staff see, limited to your own data (scope mine) or the whole organization (scope org, Owners and Admins). Counts only: sessions, how they ended, where they got stuck, and by client, for the last 30 days. Nothing agents sent is stored, so there is no list of sessions. Entries can be deleted with sessionInsightsDelete and never edited.',
		keywords: [
			'session analytics',
			'session insights',
			'agent sessions',
			'stuck',
			'analytics opt in',
		],
		readOnly: true,
		idempotent: true,
		inputSchema: z.object({ scope: scopeSchema.default('mine') }),
		outputSchema: z.object({
			session_analytics: z.enum(sessionAnalyticsStates),
			scope: z.enum(sessionInsightsScopes),
			window_days: z.number(),
			summary: z.object({
				sessions: z.number(),
				linked_sessions: z.number(),
				ended_without_errors: z.number(),
				stuck: z.number(),
				recovered: z.number(),
				nudged_sessions: z.number(),
			}),
			entries: z.array(entrySchema),
			clients: z.array(
				z.object({
					client: z.string(),
					sessions: z.number(),
					ended_without_errors: z.number(),
					stuck: z.number(),
				}),
			),
		}),
		async handler(args, ctx) {
			const owner = await ownerFor(ctx, args.scope)
			const view = await loadSessionInsights(ctx.env.APP_DB, {
				owner,
				now: new Date(),
			})
			return {
				session_analytics: await loadOrgSessionAnalyticsState(
					ctx.env.APP_DB,
					owner.orgId,
				),
				scope: args.scope,
				window_days: view.windowDays,
				summary: {
					sessions: view.summary.sessions,
					linked_sessions: view.summary.linkedSessions,
					ended_without_errors: view.summary.endedWithoutErrors,
					stuck: view.summary.stuck,
					recovered: view.summary.recovered,
					nudged_sessions: view.summary.nudgedSessions,
				},
				entries: view.entries.map((entry) => ({
					category_id: entry.categoryId,
					category: entry.categoryName,
					outcome: entry.outcome,
					stuck_kind: entry.stuckKind,
					stuck_tool: entry.stuckTool,
					sessions: entry.sessions,
					calls: entry.calls,
					errors: entry.errors,
				})),
				clients: view.clients.map((client) => ({
					client: client.clientName,
					sessions: client.sessions,
					ended_without_errors: client.endedWithoutErrors,
					stuck: client.stuck,
				})),
			}
		},
	},
)

export const sessionInsightsDeleteCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'sessionInsightsDelete',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description:
			'Delete session analytics entries for the organization this request is bound to. Pass entry (the category_id, outcome, stuck_kind, and stuck_tool of one row from sessionInsightsGet) to delete that entry, or all: true to delete everything in the scope. scope mine deletes only your own data; scope org deletes for every member and needs an Owner or Admin. Deleted numbers also leave the combined totals Kody staff and package publishers see. This cannot be undone, and entries cannot be edited.',
		keywords: ['session analytics', 'session insights', 'delete', 'erase'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			scope: scopeSchema.default('mine'),
			entry: z
				.object({
					category_id: z.string(),
					outcome: z.enum(sessionOutcomes),
					stuck_kind: z.enum(sessionStuckKinds).nullable().optional(),
					stuck_tool: z.string().nullable().optional(),
				})
				.optional()
				.describe('One entry to delete, as returned by sessionInsightsGet.'),
			all: z
				.boolean()
				.optional()
				.describe('true deletes every entry in the scope.'),
		}),
		outputSchema: z.object({
			scope: z.enum(sessionInsightsScopes),
			deleted_rows: z.number(),
		}),
		async handler(args, ctx) {
			if ((args.entry === undefined) === (args.all !== true)) {
				throw new McpCallerError('Pass exactly one of entry or all: true.')
			}
			const owner = await ownerFor(ctx, args.scope)
			const deleted = await deleteSessionInsights(ctx.env.APP_DB, {
				owner,
				...(args.entry
					? {
							entry: {
								categoryId: args.entry.category_id,
								outcome: args.entry.outcome,
								stuckKind: args.entry.stuck_kind ?? null,
								stuckTool: args.entry.stuck_tool ?? null,
							},
						}
					: {}),
			})
			return { scope: args.scope, deleted_rows: deleted.deletedRows }
		},
	},
)

export const packageSessionInsightsCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'packageSessionInsights',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		description:
			'For a public package this organization publishes: how it does across agent sessions in other organizations that turned on session analytics, over the last 30 days. Combined totals only (sessions, organizations, share ended without errors, most common stuck kinds). Returns available: false until the package has at least 10 sessions from at least 5 organizations; each stuck kind needs the same minimum. No organization, person, or session is ever identified.',
		keywords: [
			'package analytics',
			'publisher analytics',
			'session analytics',
			'package usage',
		],
		readOnly: true,
		idempotent: true,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Saved package id.'),
		}),
		outputSchema: z.object({
			available: z.boolean(),
			window_days: z.number(),
			min_sessions: z.number().optional(),
			min_orgs: z.number().optional(),
			sessions: z.number().optional(),
			orgs: z.number().optional(),
			ended_without_errors: z.number().optional(),
			stuck_kinds: z
				.array(
					z.object({
						stuck_kind: z.enum(sessionStuckKinds),
						sessions: z.number(),
					}),
				)
				.optional(),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
				userId: request.org.id,
				packageId: args.package_id,
			})
			const access = savedPackage
				? await computeEffectivePermissions({ env: ctx.env, request })
				: null
			if (
				!savedPackage ||
				!access ||
				!checkPermission(access, 'package:read', packageResource(savedPackage))
					.allowed
			) {
				throw new McpCallerError('Package was not found in this organization.')
			}
			const insights = await loadPackageSessionInsights(ctx.env.APP_DB, {
				packageId: savedPackage.id,
				now: new Date(),
			})
			if (!insights.available) {
				return {
					available: false,
					window_days: insights.windowDays,
					min_sessions: insights.minSessions,
					min_orgs: insights.minOrgs,
				}
			}
			return {
				available: true,
				window_days: insights.windowDays,
				sessions: insights.sessions,
				orgs: insights.orgs,
				ended_without_errors: insights.endedWithoutErrors,
				stuck_kinds: insights.stuckKinds.map((kind) => ({
					stuck_kind: kind.stuckKind,
					sessions: kind.sessions,
				})),
			}
		},
	},
)
