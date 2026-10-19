/**
 * soft-delete-read-filter: opt-out
 *
 * Reads every owner-keyed row an org resource transfer can touch, live and
 * soft-deleted alike: soft-deleted target rows still hold unique keys, and
 * soft-deleted source rows are what stays behind.
 */

import { type JobRow } from '@kody-internal/shared/jobs/repo.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { jobsData, type JobsDataEnv } from '#worker/jobs/jobs-data.ts'
import { mcpClientHubTransferStub } from '#worker/mcp-client/hub-transfer.ts'

export type OrgTransferRow = Record<string, unknown> & { __rowid: number }

export type OrgTransferOrg = { id: OwnerId; slug: string }

/** Tables read by owner column for both orgs. */
export const orgTransferOwnerTables = {
	saved_packages: 'user_id',
	package_capability_approvals: 'owner_user_id',
	package_security_audits: 'owner_user_id',
	package_approval_requests: 'owner_user_id',
	user_repos: 'user_id',
	entity_sources: 'user_id',
	published_bundle_artifacts: 'user_id',
	entity_source_artifacts_push_subscriptions: 'user_id',
	community_listings: 'owner_user_id',
	community_forks: 'forker_user_id',
	mcp_server_settings: 'user_id',
	mcp_user_server_instructions: 'user_id',
	user_oauth_apps: 'user_id',
	user_integrations: 'user_id',
	secret_buckets: 'user_id',
	secret_provider_bindings: 'user_id',
	secret_provider_grants: 'user_id',
	user_storage_buckets: 'user_id',
	webhook_endpoints: 'user_id',
	webhook_apply_destination_grants: 'user_id',
	webhook_apply_destination_pending: 'user_id',
	package_kody_id_redirects: 'user_id',
	package_slug_redirects: 'user_id',
	saved_package_search_index_debt: 'user_id',
	vector_embed_fingerprints: 'user_id',
	enablements: 'org_id',
	grants: 'org_id',
} as const

export type OrgTransferOwnerTable = keyof typeof orgTransferOwnerTables

/** Child tables keyed by their parent bucket, not by owner. */
export const orgTransferBucketEntryTables = {
	secret_entries: 'secret_buckets',
} as const

export type OrgTransferBucketEntryTable =
	keyof typeof orgTransferBucketEntryTables

export type OrgTransferTableRows = Record<
	OrgTransferOwnerTable | OrgTransferBucketEntryTable,
	Array<OrgTransferRow>
>

export type OrgTransferSnapshot = {
	from: OrgTransferOrg
	to: OrgTransferOrg
	source: OrgTransferTableRows
	target: OrgTransferTableRows
	/** Live jobs owned by the source org (jobs D1). */
	sourceJobs: Array<JobRow>
	/** person id → role, for live memberships of the target org. */
	targetMembers: Map<string, string>
	/** Server ids registered in each org's McpClientHub. */
	hubServerIds: { from: Set<string>; to: Set<string> }
	/** Source credentials granted to other orgs as personal credentials. */
	personalGrantCredentialIds: Set<string>
	/**
	 * Live `mcp_memories` rows owned by the source (`deleted_at` is null).
	 * Counted read-only. Memories, suppressions, and memory vectors are never
	 * loaded into the move plan.
	 */
	sourceLiveMemoryCount: number
}

async function readOwnerRows(input: {
	db: D1Database
	table: string
	ownerColumn: string
	ownerId: string
}) {
	const { results } = await input.db
		.prepare(
			`SELECT rowid AS __rowid, * FROM ${input.table} WHERE ${input.ownerColumn} = ?`,
		)
		.bind(input.ownerId)
		.all<OrgTransferRow>()
	return results ?? []
}

async function readBucketEntryRows(input: {
	db: D1Database
	table: OrgTransferBucketEntryTable
	ownerId: string
}) {
	const bucketTable = orgTransferBucketEntryTables[input.table]
	const { results } = await input.db
		.prepare(
			`SELECT e.rowid AS __rowid, e.*
			 FROM ${input.table} e
			 JOIN ${bucketTable} b ON b.id = e.bucket_id
			 WHERE b.user_id = ?`,
		)
		.bind(input.ownerId)
		.all<OrgTransferRow>()
	return results ?? []
}

export async function readOrgTransferTableRows(
	db: D1Database,
	ownerId: string,
): Promise<OrgTransferTableRows> {
	const entries = await Promise.all([
		...Object.entries(orgTransferOwnerTables).map(
			async ([table, ownerColumn]) =>
				[
					table,
					await readOwnerRows({ db, table, ownerColumn, ownerId }),
				] as const,
		),
		...(
			Object.keys(orgTransferBucketEntryTables) as Array<
				keyof typeof orgTransferBucketEntryTables
			>
		).map(
			async (table) =>
				[table, await readBucketEntryRows({ db, table, ownerId })] as const,
		),
	])
	return Object.fromEntries(entries) as OrgTransferTableRows
}

export async function loadOrgTransferSnapshot(input: {
	env: JobsDataEnv & Pick<Env, 'APP_DB' | 'MCP_CLIENT_HUB'>
	from: OrgTransferOrg
	to: OrgTransferOrg
}): Promise<OrgTransferSnapshot> {
	const db = input.env.APP_DB
	const hubServerIds = (userId: OwnerId) =>
		mcpClientHubTransferStub({ env: input.env, userId })
			.listServerIdsForTransfer()
			.then((ids) => new Set(ids))
	const [
		source,
		target,
		sourceJobs,
		members,
		fromHub,
		toHub,
		personalGrants,
		sourceLiveMemoryCount,
	] = await Promise.all([
		readOrgTransferTableRows(db, input.from.id),
		readOrgTransferTableRows(db, input.to.id),
		jobsData(input.env).listJobsForUser({ userId: input.from.id }),
		db
			.prepare(
				`SELECT user_id, role FROM org_memberships
				 WHERE org_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.to.id)
			.all<{ user_id: string; role: string }>(),
		hubServerIds(input.from.id),
		hubServerIds(input.to.id),
		db
			.prepare(
				`SELECT DISTINCT credential_id FROM credential_org_grants WHERE user_id = ?`,
			)
			.bind(input.from.id)
			.all<{ credential_id: string }>(),
		countLiveSourceMemories(db, input.from.id),
	])
	return {
		from: input.from,
		to: input.to,
		source,
		target,
		sourceJobs,
		targetMembers: new Map(
			(members.results ?? []).map((row) => [row.user_id, row.role]),
		),
		hubServerIds: { from: fromHub, to: toHub },
		personalGrantCredentialIds: new Set(
			(personalGrants.results ?? []).map((row) => row.credential_id),
		),
		sourceLiveMemoryCount,
	}
}

/** Read-only. Memories are personal and are never part of the move snapshot. */
async function countLiveSourceMemories(db: D1Database, ownerId: string) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM mcp_memories
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(ownerId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}
