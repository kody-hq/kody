import { type z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { listSavedPackagesByIds } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { listEntitySourcesByIdsForUser } from '#worker/repo/entity-sources.ts'
import {
	listRepoSessionsBySource,
	listRepoSessionsByUser,
} from '#worker/repo/repo-sessions.ts'
import { toRepoSessionInfoResult } from '#worker/repo/repo-session-tree.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	repoListSessionsInputSchema,
	repoListSessionsOutputSchema,
	type repoResolvedTargetSchema,
} from './repo-shared.ts'

type RepoResolvedTarget = z.infer<typeof repoResolvedTargetSchema>
type RepoListSessionsOutput = z.infer<typeof repoListSessionsOutputSchema>

function toResolvedSourceTarget(source: EntitySourceRow): RepoResolvedTarget {
	return {
		kind: 'source',
		source_id: source.id,
		entity_kind: source.entity_kind,
		entity_id: source.entity_id,
	}
}

function resolveListSessionTarget(input: {
	source: EntitySourceRow
	savedPackageById: ReadonlyMap<string, SavedPackageRecord>
}): RepoResolvedTarget {
	if (input.source.entity_kind === 'package') {
		const savedPackage = input.savedPackageById.get(input.source.entity_id)
		if (savedPackage) {
			return {
				kind: 'package',
				source_id: input.source.id,
				package_id: savedPackage.id,
				kody_id: savedPackage.kodyId,
				name: savedPackage.name,
			}
		}
	}
	return toResolvedSourceTarget(input.source)
}

export const repoListSessionsCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoListSessions',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'List repo editing sessions in the org this connection is bound to, defaulting to active sessions so agents can discover sessions to resume, inspect, publish, or discard without already knowing session ids.',
		keywords: [
			'repo',
			'session',
			'sessions',
			'list',
			'active',
			'discover',
			'resume',
			'discard',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoListSessionsInputSchema,
		outputSchema: repoListSessionsOutputSchema,
		async handler(args, ctx): Promise<RepoListSessionsOutput> {
			requireMcpUser(ctx.callerContext)
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const access = await computeEffectivePermissions({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
			})
			const rows = args.source_id
				? await listRepoSessionsBySource(ctx.env, {
						userId: ownerId,
						sourceId: args.source_id,
					})
				: await listRepoSessionsByUser(ctx.env, ownerId)
			const candidates = rows.filter(
				(row) =>
					row.user_id === ownerId &&
					(args.status === 'all' || row.status === args.status),
			)
			const sourceIds = [...new Set(candidates.map((row) => row.source_id))]
			const sources = await listEntitySourcesByIdsForUser(ctx.env.APP_DB, {
				userId: ownerId,
				ids: sourceIds,
			})
			const sourceById = new Map(
				sources.map((source) => [source.id, source] as const),
			)
			const packageIds = [
				...new Set(
					sources
						.filter((source) => source.entity_kind === 'package')
						.map((source) => source.entity_id),
				),
			]
			const savedPackages = await listSavedPackagesByIds(ctx.env.APP_DB, {
				userId: ownerId,
				packageIds,
			})
			const savedPackageById = new Map(
				savedPackages.map(
					(savedPackage) => [savedPackage.id, savedPackage] as const,
				),
			)
			const sessions: RepoListSessionsOutput['sessions'] = []
			for (const row of candidates) {
				const source = sourceById.get(row.source_id)
				if (
					!source ||
					(source.entity_kind === 'package' &&
						!checkPermission(
							access,
							'package:read',
							packageResource({
								id: source.entity_id,
								userId: source.user_id,
							}),
						).allowed)
				) {
					continue
				}
				sessions.push({
					...toRepoSessionInfoResult(row, source),
					status: row.status,
					resolved_target: resolveListSessionTarget({
						source,
						savedPackageById,
					}),
				})
				if (sessions.length >= args.limit) break
			}
			return { sessions }
		},
	},
)
