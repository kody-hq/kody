import {
	credentialKinds,
	credentialPermissionFamily,
	getOrgCredential,
	type CredentialKind,
} from '#worker/credentials/credential-ids.ts'
import {
	auditDatabaseFromEnvOrThrow,
	type OrgAuditWriter,
} from './org-audit.ts'
import {
	createdPackageResources,
	findMemberRole,
	findUserGrantState,
	grantCreatorAccess,
	type CreatedResource,
} from './creator-access.ts'

export const creatorAccessBackfillLimitDefault = 25
export const creatorAccessBackfillLimitMax = 100

export const creatorAccessBackfillOutcomes = [
	'would_grant',
	'granted',
	'already_granted',
	'previously_revoked',
	'creator_is_owner',
	'creator_not_member',
	'resource_gone',
] as const

export type CreatorAccessBackfillOutcome =
	(typeof creatorAccessBackfillOutcomes)[number]

export type CreatorAccessBackfillDetail = {
	orgId: string
	resourceType: 'package' | 'app' | 'credential'
	resourceId: string
	creatorUserId: string
	outcome: CreatorAccessBackfillOutcome
}

type AuditRow = {
	actor_user_id: string
	action: string
	resource_id: string | null
	details_json: string | null
}

type Creation = {
	kind: 'package' | 'credential'
	resourceId: string
	creatorUserId: string
	credentialKind: CredentialKind | null
}

/**
 * Creator grants for things members made before creators got one on create.
 * The creator is the actor of the first-publish audit row (packages) or the
 * `credential.created` row (team credentials). Owners, ex-members, deleted
 * resources, and any person whose grant on the resource was ever revoked are
 * skipped, so a rerun or an Owner's earlier revoke is never undone.
 */
export async function runCreatorAccessBackfill(input: {
	env: Env
	dryRun: boolean
	audit: OrgAuditWriter | null
	afterOrgId: string | null
	limit?: number
	orgIds?: ReadonlyArray<string>
}) {
	const limit = Math.min(
		input.limit ?? creatorAccessBackfillLimitDefault,
		creatorAccessBackfillLimitMax,
	)
	const orgIds = input.orgIds
		? [...input.orgIds].sort()
		: await listOrgsWithNonOwnerMembers(input.env.APP_DB, {
				afterOrgId: input.afterOrgId,
				limit,
			})
	const auditDb = auditDatabaseFromEnvOrThrow(input.env)
	const counts = Object.fromEntries(
		creatorAccessBackfillOutcomes.map((outcome) => [outcome, 0]),
	) as Record<CreatorAccessBackfillOutcome, number>
	const details: Array<CreatorAccessBackfillDetail> = []
	for (const orgId of orgIds) {
		for (const creation of await listCreations(auditDb, orgId)) {
			for (const item of await classifyCreation(input, orgId, creation)) {
				counts[item.outcome] += 1
				details.push(item)
			}
		}
	}
	const nextCursor =
		!input.orgIds && orgIds.length === limit ? orgIds.at(-1)! : null
	return {
		dryRun: input.dryRun,
		orgsScanned: orgIds.length,
		...counts,
		nextCursor,
		details,
	}
}

async function classifyCreation(
	input: { env: Env; dryRun: boolean; audit: OrgAuditWriter | null },
	orgId: string,
	creation: Creation,
): Promise<Array<CreatorAccessBackfillDetail>> {
	const resources = await liveResources(input.env.APP_DB, orgId, creation)
	const base = { orgId, creatorUserId: creation.creatorUserId }
	if (resources == null) {
		return [
			{
				...base,
				resourceType: creation.kind,
				resourceId: creation.resourceId,
				outcome: 'resource_gone',
			},
		]
	}
	const role = await findMemberRole(input.env.APP_DB, {
		orgId,
		userId: creation.creatorUserId,
	})
	const out: Array<CreatorAccessBackfillDetail> = []
	for (const resource of resources) {
		const detail = {
			...base,
			resourceType:
				resource.resourceType as CreatorAccessBackfillDetail['resourceType'],
			resourceId: resource.resourceId,
		}
		if (role == null) {
			out.push({ ...detail, outcome: 'creator_not_member' })
			continue
		}
		if (role === 'owner') {
			out.push({ ...detail, outcome: 'creator_is_owner' })
			continue
		}
		const state = await findUserGrantState(input.env.APP_DB, {
			orgId,
			resource,
			userId: creation.creatorUserId,
		})
		if (state !== 'none') {
			out.push({
				...detail,
				outcome: state === 'live' ? 'already_granted' : 'previously_revoked',
			})
			continue
		}
		if (input.dryRun) {
			out.push({ ...detail, outcome: 'would_grant' })
			continue
		}
		const { granted } = await grantCreatorAccess({
			env: input.env,
			orgId,
			creatorUserId: creation.creatorUserId,
			resources: [resource],
			audit: input.audit,
			neverRegrant: true,
		})
		out.push({
			...detail,
			outcome: granted > 0 ? 'granted' : 'already_granted',
		})
	}
	return out
}

async function liveResources(
	db: D1Database,
	orgId: string,
	creation: Creation,
): Promise<Array<CreatedResource> | null> {
	if (creation.kind === 'package') {
		const row = await db
			.prepare(
				`SELECT 1 AS ok FROM saved_packages
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(creation.resourceId, orgId)
			.first<{ ok: number }>()
		return row ? createdPackageResources(creation.resourceId) : null
	}
	const credential = await getOrgCredential(db, orgId, creation.resourceId)
	if (!credential?.live || credential.kind !== creation.credentialKind) {
		return null
	}
	return [
		{
			resourceType: 'credential',
			resourceId: credential.id,
			family: credentialPermissionFamily(credential.kind),
		},
	]
}

async function listOrgsWithNonOwnerMembers(
	db: D1Database,
	input: { afterOrgId: string | null; limit: number },
) {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT org_id FROM org_memberships
			 WHERE deleted_at IS NULL AND role != 'owner' AND org_id > ?
			 ORDER BY org_id LIMIT ?`,
		)
		.bind(input.afterOrgId ?? '', input.limit)
		.all<{ org_id: string }>()
	return results.map((row) => row.org_id)
}

/** The earliest create row per resource; later rows never change the creator. */
async function listCreations(auditDb: D1Database, orgId: string) {
	const { results } = await auditDb
		.prepare(
			`SELECT actor_user_id, action, resource_id, details_json
			 FROM org_audit_events
			 WHERE org_id = ? AND result = 'success' AND actor_user_id IS NOT NULL
			   AND action IN ('package.published', 'credential.created')
			 ORDER BY created_at, id`,
		)
		.bind(orgId)
		.all<AuditRow>()
	const seen = new Map<string, Creation>()
	for (const row of results) {
		if (!row.resource_id) continue
		const details = parseDetails(row.details_json)
		const creation = creationFromRow(row, row.resource_id, details)
		if (!creation) continue
		const key = `${creation.kind}:${creation.resourceId}`
		if (!seen.has(key)) seen.set(key, creation)
	}
	return [...seen.values()]
}

function creationFromRow(
	row: AuditRow,
	resourceId: string,
	details: Record<string, unknown>,
): Creation | null {
	if (row.action === 'package.published') {
		if (details['firstPublish'] !== true) return null
		return {
			kind: 'package',
			resourceId,
			creatorUserId: row.actor_user_id,
			credentialKind: null,
		}
	}
	const kind = details['credentialKind']
	if (
		typeof kind !== 'string' ||
		kind === 'vault' ||
		!(credentialKinds as ReadonlyArray<string>).includes(kind)
	) {
		return null
	}
	return {
		kind: 'credential',
		resourceId,
		creatorUserId: row.actor_user_id,
		credentialKind: kind as CredentialKind,
	}
}

function parseDetails(json: string | null): Record<string, unknown> {
	if (!json) return {}
	try {
		const value: unknown = JSON.parse(json)
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}
