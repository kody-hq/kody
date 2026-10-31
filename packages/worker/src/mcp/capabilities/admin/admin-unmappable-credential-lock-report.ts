import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { loadPackageUnmappableCredentials } from '#worker/credentials/package-unmappable-credentials.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const pageSizeMax = 100
const reportTtlSeconds = 24 * 60 * 60
const reportKeyPrefix = 'admin-unmappable-credential-lock-report:'
const count = z.number().int().nonnegative()

const countsSchema = z.object({
	packagesScanned: count.describe(
		'Packages with at least one live grant that can change or publish them.',
	),
	packagesLocked: count.describe(
		'Of those, packages with unmappable credentials and at least one locked grant.',
	),
	grantsLocked: count.describe(
		'Live change-capable grants without the allow option on a locked package.',
	),
	collaboratorsLocked: count.describe(
		'Distinct people, teams, or whole-org subjects behind grantsLocked, per package.',
	),
	grantsAllowed: count.describe(
		'Change-capable grants an Owner allowed despite unmappable credentials.',
	),
	packagesUnchecked: count.describe(
		'Packages whose credentials could not be inspected (locked, fail closed).',
	),
})

const inputSchema = z.object({
	runId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(pageSizeMax).default(50),
})

const outputSchema = z.object({
	runId: z.string(),
	complete: z.boolean(),
	counts: countsSchema,
})

type ReportCounts = z.infer<typeof countsSchema>

type ReportState = {
	cursor: string | null
	complete: boolean
	counts: ReportCounts
}

type GrantRow = {
	org_id: string
	package_id: string
	subject_type: string
	subject_id: string
	allowed: number | null
}

function emptyCounts(): ReportCounts {
	return {
		packagesScanned: 0,
		packagesLocked: 0,
		grantsLocked: 0,
		collaboratorsLocked: 0,
		grantsAllowed: 0,
		packagesUnchecked: 0,
	}
}

const changeGrantSql = `g.resource_type = 'package'
	AND (g.expires_at IS NULL OR g.expires_at > ?)
	AND EXISTS (
		SELECT 1 FROM grant_permissions gp
		WHERE gp.grant_id = g.id
			AND gp.permission IN ('package:write', 'package:publish')
	)`

export async function scanUnmappableCredentialLockReportStep(input: {
	env: Env
	state: ReportState
	limit: number
	now?: string
}) {
	const now = input.now ?? new Date().toISOString()
	const packages =
		(
			await input.env.APP_DB.prepare(
				`SELECT DISTINCT g.resource_id AS package_id
				FROM grants g
				WHERE g.deleted_at IS NULL AND ${changeGrantSql} AND g.resource_id > ?
				ORDER BY g.resource_id
				LIMIT ?`,
			)
				.bind(now, input.state.cursor ?? '', input.limit + 1)
				.all<{ package_id: string }>()
		).results ?? []
	const page = packages.slice(0, input.limit).map((row) => row.package_id)
	if (page.length > 0) {
		const grants =
			(
				await input.env.APP_DB.prepare(
					`SELECT g.org_id AS org_id, g.resource_id AS package_id,
						g.subject_type AS subject_type, g.subject_id AS subject_id,
						g.allow_unmappable_credential_changes AS allowed
					FROM grants g
					WHERE g.deleted_at IS NULL AND ${changeGrantSql}
						AND g.resource_id IN (${page.map(() => '?').join(', ')})`,
				)
					.bind(now, ...page)
					.all<GrantRow>()
			).results ?? []
		const packageIdsByOrg = new Map<string, Set<string>>()
		for (const grant of grants) {
			const ids = packageIdsByOrg.get(grant.org_id) ?? new Set<string>()
			ids.add(grant.package_id)
			packageIdsByOrg.set(grant.org_id, ids)
		}
		const counts = input.state.counts
		for (const [orgId, packageIds] of packageIdsByOrg) {
			const unmappable = await loadPackageUnmappableCredentials({
				env: input.env,
				orgId,
				packageIds: [...packageIds],
			})
			for (const packageId of packageIds) {
				counts.packagesScanned += 1
				const credentials = unmappable.get(packageId) ?? []
				if (credentials.length === 0) continue
				if (
					credentials.some((credential) => credential.reason === 'unchecked')
				) {
					counts.packagesUnchecked += 1
				}
				const subjects = new Set<string>()
				for (const grant of grants) {
					if (grant.org_id !== orgId || grant.package_id !== packageId) continue
					if (grant.allowed === 1) {
						counts.grantsAllowed += 1
						continue
					}
					counts.grantsLocked += 1
					subjects.add(`${grant.subject_type}:${grant.subject_id}`)
				}
				if (subjects.size > 0) counts.packagesLocked += 1
				counts.collaboratorsLocked += subjects.size
			}
		}
		input.state.cursor = page.at(-1) ?? input.state.cursor
	}
	input.state.complete = packages.length <= input.limit
	return input.state
}

export const adminUnmappableCredentialLockReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminUnmappableCredentialLockReport',
		contextRuns: 'deny',
		description:
			'Read-only, counts-only report of packages whose unmappable credentials lock collaborator changes: packages and change-capable grants locked, distinct collaborators locked, grants an Owner allowed, and packages that could not be inspected. Pages with runId until complete. Never returns names, handles, emails, need keys, credential names, or ids. Admin-only.',
		keywords: [
			'admin',
			'unmappable',
			'credential',
			'lock',
			'collaborators',
			'grants',
			'counts',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminUnmappableCredentialLockReport',
				async () => {
					await resolveActingAdminPerson(ctx)
					const runId = args.runId ?? crypto.randomUUID()
					const key = `${reportKeyPrefix}${runId}`
					const current = args.runId
						? await ctx.env.BUNDLE_ARTIFACTS_KV.get<ReportState>(key, 'json')
						: null
					if (args.runId && !current) {
						throw new Error(
							'Unmappable credential lock report run was not found.',
						)
					}
					const state: ReportState = current ?? {
						cursor: null,
						complete: false,
						counts: emptyCounts(),
					}
					if (!state.complete) {
						await scanUnmappableCredentialLockReportStep({
							env: ctx.env,
							state,
							limit: args.limit,
						})
						await ctx.env.BUNDLE_ARTIFACTS_KV.put(key, JSON.stringify(state), {
							expirationTtl: reportTtlSeconds,
						})
					}
					return { runId, complete: state.complete, counts: state.counts }
				},
				{
					successReason: (result) =>
						`complete=${String(result.complete)};packagesLocked=${String(result.counts.packagesLocked)};collaboratorsLocked=${String(result.counts.collaboratorsLocked)}`,
				},
			)
		},
	})
