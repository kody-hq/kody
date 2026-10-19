import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	personalOrgId,
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	accountExportForeignUserIdColumnsByTable,
	accountExportRedactedColumnsByTable,
	accountExportRedactedForeignUserId,
	accountUserDataTargets,
	buildUserScopedTargetMatch,
	getAccountExportExcludedD1Surfaces,
	isExcludedFromAccountExport,
	getAccountD1UserColumnCoverage,
} from '#worker/account/data-targets.ts'
import { getAccountExportExcludedDurableObjects } from '#worker/account/user-owned-surfaces.ts'
import {
	countAccountR2ObjectRefs,
	readAccountR2ExportPage,
} from '#worker/account/r2-export.ts'
import { exportJobManagerForUser } from '#worker/jobs/manager-client.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { buildCommunitySnapshotKvKey } from '#worker/community/snapshot.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import {
	exportRunRecords,
	listRunRecordStorageIds,
	summarizeRunRecords,
} from '#worker/run-records/service.ts'
import {
	userMeterNamespace,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import { type UserMeterExportResult } from '#worker/entitlements/user-meter-do.ts'
import {
	countInternalUserMailboxRows,
	exportInternalUserMailbox,
} from '#worker/email/mailbox-internal-read.ts'
import { type MailboxExportResult } from '#worker/email/mailbox-types.ts'
import {
	repoSessionIndexNamespace,
	repoSessionIndexRpc,
} from '#worker/repo/repo-session-index-client.ts'
import { type RepoSessionIndexExportResult } from '#worker/repo/repo-session-index-do.ts'
import { listAccountUserStorageIds } from '#worker/account/user-inventory.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const accountExportSchemaVersion = 1
const defaultExportPageSize = 100
const maxExportPageSize = 500
// Full exports stream each D1 table in keyset-paged batches of this size so
// memory stays bounded per query even for very large tables (e.g. mailboxes).
const d1ExportPageSize = 500
// Internal alias for the SQLite rowid used as the keyset cursor. Stripped from
// exported rows so the export document schema is unchanged.
const exportRowidColumn = '__account_export_rowid'

export const accountExportSectionNames = [
	'd1_table',
	'storage_runner',
	'job_manager',
	'run_records',
	'user_meter',
	'mailbox',
	'repo_session_index',
	'oauth_grants',
	'artifact_repos',
	'kv_keys',
	'r2_object',
	'durable_object_summaries',
] as const

export type AccountExportSectionName =
	(typeof accountExportSectionNames)[number]

type OAuthGrantPage = {
	items: Array<{ id: string; clientId: string }>
	cursor?: string
}

type OAuthHelpersShape = {
	listUserGrants(
		userId: OwnerId,
		options: { cursor: string | undefined },
	): Promise<OAuthGrantPage>
}

type AccountExportEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpersShape
}

const oauthSurfaceUnavailableWarning =
	'OAuth provider binding and OAUTH_KV were unavailable; OAuth grant metadata was not exported.'

/**
 * `OAUTH_PROVIDER` exists only inside the provider's `fetch` wrapper, so
 * `accountExportManifest` / `accountExportSection` served from the sessionful
 * `MCP` Durable Object on kody-platform get the library-built helpers from
 * `resolveOAuthHelpers` instead.
 */
function resolveOAuthGrantReader(
	env: AccountExportEnv,
): Promise<OAuthHelpersShape | undefined> {
	return resolveOAuthHelpers(env)
}

type UserSourceSnapshot = {
	sourceId: string
	publishedCommit: string | null
	repoId: string
	entityKind: string
	entityId: string
	manifestPath: string
	sourceRoot: string
}

type UserSavedPackageSnapshot = {
	id: string
	kodyId: string
	sourceId: string
	hasApp: boolean
}

type UserExportInventory = {
	storageIds: Array<string>
	sourceSnapshots: Array<UserSourceSnapshot>
	savedPackages: Array<UserSavedPackageSnapshot>
	communityListingIds: Array<string>
	bundleKvKeys: Array<string>
	r2ObjectCount: number
	artifactRepos: Array<AccountExportArtifactRepo>
}

type ManifestInventoryCounts = {
	storageRunners: number
	runRecords: number
	userMeterCounters: number
	mailboxRows: number
	repoSessionIndexRows: number
	artifactRepos: number
	kvKeys: number
	r2Objects: number
}

export type AccountExportManifestSection = {
	count: number
	warnings: Array<string>
	redactedColumns?: Array<string>
	discovery?: {
		section: AccountExportSectionName
		kind?: string
	}
}

export type AccountExportManifest = {
	schemaVersion: number
	generatedAt: string
	user: {
		dbUserId: number
		userId: OwnerId
	}
	security: {
		secretValuesExported: false
		note: string
	}
	sections: Record<string, AccountExportManifestSection>
	warnings: Array<string>
	chunking: {
		sections: Array<AccountExportSectionName>
		defaultPageSize: number
		maxPageSize: number
	}
	artifacts: {
		canonicalPackageSource: string
	}
	derivedData: {
		vectorize: string
		r2: string
	}
	excludedOperationalData: {
		email_outbound_provider_index: string
		email_outbound_failure_tracking: string
		transactional_email_delivery_index: string
	}
	excludedDurableObjects: Array<{
		name: string
		reason: string
	}>
	excludedD1Surfaces: Array<{
		name: string
		reason: string
	}>
}

export type AccountExportD1Table = {
	table: string
	rows: Array<Record<string, unknown>>
	redactedColumns: Array<string>
	warnings: Array<string>
}

export type AccountExportArtifactRepo = {
	sourceId: string
	entityKind: string
	entityId: string
	repoId: string
	publishedCommit: string | null
	manifestPath: string
	sourceRoot: string
}

type RunRecordsExportPayload = Awaited<ReturnType<typeof exportRunRecords>>

function countUserMeterExportEntries(result: UserMeterExportResult): number {
	const deletionStateCount =
		result.deletionState == null
			? 0
			: (result.deletionState.deletingAt == null ? 0 : 1) +
				result.deletionState.activeWriteLeaseCount
	return (
		result.counters.length +
		(result.storageBytesState == null ? 0 : 1) +
		deletionStateCount +
		(result.inboundConnectionLastUsed?.length ?? 0)
	)
}

function countRunRecordsExportEntries(
	runRecords: RunRecordsExportPayload | null | undefined,
) {
	if (runRecords == null) return 0
	return (
		runRecords.runs.length +
		runRecords.packageInvocations.length +
		runRecords.workflowProjections.length +
		runRecords.jobRunObservability.length +
		runRecords.packageRunSuccesses.length +
		runRecords.activationMilestones.length
	)
}

function formatRunRecordsExportSectionItems(page: RunRecordsExportPayload) {
	return [
		...page.runs.map((run) => ({
			run,
			logs: page.logs.filter((log) => log.runId === run.id),
		})),
		...page.packageInvocations.map((packageInvocation) => ({
			packageInvocation,
		})),
		...page.workflowProjections.map((workflowProjection) => ({
			workflowProjection,
		})),
		...page.jobRunObservability.map((jobRunObservability) => ({
			jobRunObservability,
		})),
		...page.packageRunSuccesses.map((packageRunSuccess) => ({
			packageRunSuccess,
		})),
		...page.activationMilestones.map((activationMilestone) => ({
			activationMilestone,
		})),
	]
}

type AccountExportDurableObjects = {
	jobManager: unknown | null
	runRecords: RunRecordsExportPayload | null
	userMeter: UserMeterExportResult | null
	mailbox: MailboxExportResult | null
	repoSessionIndex: RepoSessionIndexExportResult | null
	storageRunners: Array<{
		storageId: string
		export: Awaited<
			ReturnType<ReturnType<typeof storageRunnerRpc>['exportStorage']>
		>
	}>
}

export type AccountExportFile = {
	manifest: AccountExportManifest
	d1: Record<string, AccountExportD1Table>
	durableObjects: AccountExportDurableObjects
	oauthGrants: Array<{ id: string; clientId: string }>
	artifactRepos: Array<AccountExportArtifactRepo>
	kvKeys: Array<string>
}

export type AccountExportSectionResult = {
	section: AccountExportSectionName
	items: Array<unknown>
	truncated: boolean
	nextStartAfter: string | null
	pageSize: number
	warnings: Array<string>
	/**
	 * Authoritative UserMeter storage-byte state. Present only on the first
	 * `user_meter` page (`startAfter` absent); later pages set it to `null`.
	 */
	storageBytesState?: UserMeterExportResult['storageBytesState']
	/**
	 * Sanitized UserMeter deletion-fence / write-lease inventory (no raw token
	 * or holder). Present only on the first `user_meter` page (`startAfter`
	 * absent); later pages set it to `null`.
	 */
	deletionState?: UserMeterExportResult['deletionState']
	/**
	 * Inbound MCP OAuth last-used stamps. Present only on the first
	 * `user_meter` page (`startAfter` absent); later pages set it to `null`.
	 */
	inboundConnectionLastUsed?: UserMeterExportResult['inboundConnectionLastUsed']
}

function normalizePageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultExportPageSize
	return Math.min(Math.max(requested, 1), maxExportPageSize)
}

function paginateItems<T>(input: {
	items: ReadonlyArray<T>
	pageSize: number | undefined
	startAfter: string | undefined
}) {
	const pageSize = normalizePageSize(input.pageSize)
	const startIndex = input.startAfter
		? Number.parseInt(input.startAfter, 10)
		: 0
	const safeStart =
		Number.isFinite(startIndex) && startIndex > 0 ? startIndex : 0
	const page = input.items.slice(safeStart, safeStart + pageSize)
	const nextIndex = safeStart + page.length
	const truncated = nextIndex < input.items.length
	return {
		items: page,
		truncated,
		nextStartAfter: truncated ? String(nextIndex) : null,
		pageSize,
	}
}

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

function normalizeBoolean(value: unknown) {
	return value === 1 || value === '1' || value === true
}

type D1TableCondition = {
	condition: string
	params: Array<unknown>
}

/**
 * Resolve personal-org owner + person ids for account export.
 * `mcpUserId` alone keeps equal-id behavior for existing callers.
 */
function resolveAccountExportUserIds(input: {
	ownerUserId?: OwnerId
	personUserId?: PersonId
	mcpUserId?: OwnerId
}): { ownerUserId: OwnerId; personUserId: PersonId } {
	const ownerUserId = input.ownerUserId ?? input.mcpUserId
	if (!ownerUserId) {
		throw new Error('Account export requires ownerUserId or mcpUserId.')
	}
	const personUserId =
		input.personUserId ?? personIdFromStored(ownerUserId as string)
	return { ownerUserId, personUserId }
}

function buildD1TableConditions(input: {
	mcpUserId: OwnerId
	personUserId?: PersonId
	dbUserId: number
}) {
	const conditionsByTable = new Map<string, Array<D1TableCondition>>()
	function add(table: string, condition: D1TableCondition) {
		const existing = conditionsByTable.get(table)
		if (existing) {
			existing.push(condition)
			return
		}
		conditionsByTable.set(table, [condition])
	}
	add('users', { condition: `users.id = ?`, params: [input.dbUserId] })
	for (const target of accountUserDataTargets) {
		if (isExcludedFromAccountExport(target)) {
			continue
		}
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.mcpUserId,
			personUserId: input.personUserId,
			dbUserId: input.dbUserId,
		})
		add(match.table, {
			condition: match.qualifiedWhereSql,
			params: [...match.params],
		})
	}
	return conditionsByTable
}

function sanitizeRow(
	table: string,
	row: Record<string, unknown>,
	ownerUserId: OwnerId,
	personUserId: PersonId,
) {
	const redactedColumns = accountExportRedactedColumnsByTable[table] ?? []
	const foreignUserIdColumns =
		accountExportForeignUserIdColumnsByTable[table] ?? []
	const ownedIds = new Set<string>([ownerUserId, personUserId])
	const sanitized: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(row)) {
		if (redactedColumns.includes(key)) continue
		if (
			foreignUserIdColumns.includes(key) &&
			typeof value === 'string' &&
			!ownedIds.has(value)
		) {
			sanitized[key] = accountExportRedactedForeignUserId
			continue
		}
		sanitized[key] = value
	}
	return {
		row: sanitized,
		redactedColumns: redactedColumns.filter((column) => column in row),
	}
}

function rowDedupeKey(row: Record<string, unknown>) {
	if ('id' in row && row.id !== null && row.id !== undefined)
		return String(row.id)
	if ('bucket_id' in row && 'name' in row) {
		return `${String(row.bucket_id)}:${String(row.name)}`
	}
	if ('user_id' in row && 'role_id' in row) {
		return `${String(row.user_id)}:${String(row.role_id)}`
	}
	return JSON.stringify(row)
}

function sortRowsByDedupeKey(rows: Array<Record<string, unknown>>) {
	return rows.sort((left, right) =>
		rowDedupeKey(left).localeCompare(rowDedupeKey(right)),
	)
}

async function selectRows<T extends Record<string, unknown>>(
	env: Env,
	sql: string,
	params: ReadonlyArray<unknown>,
) {
	const result = await env.APP_DB.prepare(sql)
		.bind(...params)
		.all<T>()
	return result.results ?? []
}

// Reads one keyset page of a table: rows are selected by ascending rowid
// strictly after the cursor, with a SQL LIMIT, so a single query never loads
// more than one page regardless of table size. Conditions for every export
// target of the table are OR-combined into one query, which also removes the
// need for cross-target row deduplication.
async function selectD1TablePage(input: {
	env: AccountExportEnv
	table: string
	conditions: ReadonlyArray<D1TableCondition>
	mcpUserId: OwnerId
	personUserId: PersonId
	afterRowid: number
	limit: number
}) {
	const where = input.conditions
		.map((condition) => `(${condition.condition})`)
		.join(' OR ')
	const sql = `SELECT ${input.table}.rowid AS ${exportRowidColumn}, ${input.table}.*
		FROM ${input.table}
		WHERE (${where}) AND ${input.table}.rowid > ?
		ORDER BY ${input.table}.rowid
		LIMIT ?`
	const params = [
		...input.conditions.flatMap((condition) => condition.params),
		input.afterRowid,
		input.limit + 1,
	]
	const rawRows = await selectRows(input.env, sql, params)
	const truncated = rawRows.length > input.limit
	const pageRows = truncated ? rawRows.slice(0, input.limit) : rawRows
	let lastRowid = input.afterRowid
	const rows: Array<ReturnType<typeof sanitizeRow>> = []
	for (const rawRow of pageRows) {
		const { [exportRowidColumn]: rowid, ...columns } = rawRow
		lastRowid = Number(rowid)
		rows.push(
			sanitizeRow(input.table, columns, input.mcpUserId, input.personUserId),
		)
	}
	return { rows, lastRowid, truncated }
}

async function collectD1TableRows(input: {
	env: AccountExportEnv
	table: string
	conditions: ReadonlyArray<D1TableCondition>
	mcpUserId: OwnerId
	personUserId: PersonId
	warnings: Array<string>
}): Promise<AccountExportD1Table> {
	const section: AccountExportD1Table = {
		table: input.table,
		rows: [],
		redactedColumns: [],
		warnings: [],
	}
	const redacted = new Set<string>()
	let afterRowid = 0
	try {
		while (true) {
			const page = await selectD1TablePage({
				env: input.env,
				table: input.table,
				conditions: input.conditions,
				mcpUserId: input.mcpUserId,
				personUserId: input.personUserId,
				afterRowid,
				limit: d1ExportPageSize,
			})
			for (const entry of page.rows) {
				for (const column of entry.redactedColumns) redacted.add(column)
				section.rows.push(entry.row)
			}
			if (!page.truncated) break
			afterRowid = page.lastRowid
		}
	} catch (error) {
		const warning = `D1 export failed for ${input.table}: ${getErrorMessage(error)}`
		section.warnings.push(warning)
		input.warnings.push(warning)
	}
	section.rows = sortRowsByDedupeKey(section.rows)
	section.redactedColumns = Array.from(redacted).sort()
	return section
}

async function listUserStorageIds(env: Env, userId: OwnerId) {
	return await listAccountUserStorageIds({
		env,
		userId,
	})
}

/**
 * Entity/registry storage ids used by discovery paging (no manifests):
 * APP_DB registry buckets plus job storage ids from the jobs worker (ADR
 * 0016). Job counts are entitlement-bounded, so job ids are merged in
 * memory around bounded keyset SQL pages over the registry buckets.
 */
const exportBucketStorageIdSql = `SELECT storage_id AS id FROM user_storage_buckets
	WHERE user_id = ? AND kind <> 'repo_session'`

async function listExportJobStorageIds(
	env: Env,
	userId: OwnerId,
): Promise<Array<string>> {
	const ids = await jobsData(env).listJobStorageIdsForUser({ userId })
	return [...ids].sort()
}

async function listExportBaseStorageIds(
	env: Env,
	userId: OwnerId,
): Promise<Array<string>> {
	const [bucketRows, jobStorageIds] = await Promise.all([
		env.APP_DB.prepare(exportBucketStorageIdSql)
			.bind(userId)
			.all<{ id: string }>(),
		listExportJobStorageIds(env, userId),
	])
	const ids = new Set<string>(jobStorageIds)
	for (const row of bucketRows.results ?? []) ids.add(row.id)
	return [...ids].sort()
}

async function listExportBaseStorageIdPage(
	env: Env,
	userId: OwnerId,
	afterId: string,
	pageSize: number,
): Promise<{ ids: Array<string>; truncated: boolean }> {
	const [bucketRows, jobStorageIds] = await Promise.all([
		env.APP_DB.prepare(
			`${exportBucketStorageIdSql} AND storage_id > ? ORDER BY storage_id LIMIT ?`,
		)
			.bind(userId, afterId, pageSize + 1)
			.all<{ id: string }>(),
		listExportJobStorageIds(env, userId),
	])
	const merged = new Set<string>(
		(bucketRows.results ?? []).map((row) => row.id),
	)
	for (const id of jobStorageIds) if (id > afterId) merged.add(id)
	const sorted = [...merged].sort()
	return {
		ids: sorted.slice(0, pageSize),
		truncated: sorted.length > pageSize,
	}
}

async function listExportD1DiscoverableStorageIds(env: Env, userId: OwnerId) {
	return new Set(await listExportBaseStorageIds(env, userId))
}

async function isExportDiscoverableStorageId(
	env: Env,
	userId: OwnerId,
	storageId: string,
) {
	const jobStorageIds = await listExportJobStorageIds(env, userId)
	if (jobStorageIds.includes(storageId)) return true
	const bucketRow = await env.APP_DB.prepare(
		`SELECT 1 AS owned FROM (${exportBucketStorageIdSql}) WHERE id = ?`,
	)
		.bind(userId, storageId)
		.first<{ owned: number }>()
	if (bucketRow?.owned === 1) return true
	const runRecordStorageIds = await listRunRecordStorageIds({ env, userId })
	return runRecordStorageIds.includes(storageId)
}
async function listUserSourceSnapshots(env: Env, userId: OwnerId) {
	const rows = await selectRows<{
		id: string
		published_commit: string | null
		repo_id: string
		entity_kind: string
		entity_id: string
		manifest_path: string
		source_root: string
	}>(
		env,
		`SELECT id, published_commit, repo_id, entity_kind, entity_id, manifest_path, source_root
		FROM entity_sources
		WHERE user_id = ?`,
		[userId],
	)
	return rows.map((row) => ({
		sourceId: row.id,
		publishedCommit: row.published_commit,
		repoId: row.repo_id,
		entityKind: row.entity_kind,
		entityId: row.entity_id,
		manifestPath: row.manifest_path,
		sourceRoot: row.source_root,
	}))
}

async function listUserSavedPackages(env: Env, userId: OwnerId) {
	const rows = await selectRows<{
		id: string
		kody_id: string
		source_id: string
		has_app: number | string | boolean
	}>(
		env,
		`SELECT id, kody_id, source_id, has_app
		FROM saved_packages
		WHERE user_id = ?`,
		[userId],
	)
	return rows.map((row) => ({
		id: row.id,
		kodyId: row.kody_id,
		sourceId: row.source_id,
		hasApp: normalizeBoolean(row.has_app),
	}))
}

async function listUserBundleKvKeys(input: {
	env: Env
	userId: OwnerId
	sourceSnapshots: ReadonlyArray<UserSourceSnapshot>
	communityListingIds: ReadonlyArray<string>
	warnings: Array<string>
}) {
	const published = await selectRows<{ kv_key: string }>(
		input.env,
		`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`,
		[input.userId],
	)
	const keys = new Set(
		uniqueStrings([
			...published.map((row) => row.kv_key),
			...input.sourceSnapshots.flatMap((source) =>
				source.publishedCommit
					? [
							buildPublishedSourceSnapshotKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
							buildPublishedSourceManifestSnapshotKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
						]
					: [],
			),
			...input.communityListingIds.map(buildCommunitySnapshotKvKey),
		]),
	)
	if (!input.env.BUNDLE_ARTIFACTS_KV?.list) return Array.from(keys)
	const prefixes = input.sourceSnapshots.flatMap((source) => [
		`source-snapshot:v1:${source.sourceId}:`,
		`source-manifest-snapshot:v1:${source.sourceId}:`,
	])
	for (const prefix of prefixes) {
		let cursor: string | undefined
		do {
			try {
				const result = await input.env.BUNDLE_ARTIFACTS_KV.list({
					prefix,
					cursor,
				})
				for (const key of result.keys) {
					keys.add(key.name)
				}
				cursor = result.list_complete ? undefined : result.cursor
			} catch (error) {
				input.warnings.push(
					`KV prefix listing failed for ${prefix}: ${getErrorMessage(error)}`,
				)
				cursor = undefined
			}
		} while (cursor)
	}
	return Array.from(keys).sort()
}

async function listUserCommunityListingIds(env: Env, userId: OwnerId) {
	const rows = await selectRows<{ id: string }>(
		env,
		`SELECT id FROM community_listings WHERE owner_user_id = ?`,
		[userId],
	)
	return uniqueStrings(rows.map((row) => row.id))
}

async function collectInventory(input: {
	env: AccountExportEnv
	userId: OwnerId
	dbUserId: number
	warnings: Array<string>
}): Promise<UserExportInventory> {
	const [
		storageIds,
		sourceSnapshots,
		savedPackages,
		communityListingIds,
		r2ObjectCount,
	] = await Promise.all([
		listUserStorageIds(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate storage ids: ${getErrorMessage(error)}`,
			)
			return [] as Array<string>
		}),
		listUserSourceSnapshots(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate entity sources: ${getErrorMessage(error)}`,
			)
			return [] as Array<UserSourceSnapshot>
		}),
		listUserSavedPackages(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate saved packages: ${getErrorMessage(error)}`,
			)
			return [] as Array<UserSavedPackageSnapshot>
		}),
		listUserCommunityListingIds(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate community listings: ${getErrorMessage(error)}`,
			)
			return [] as Array<string>
		}),
		countAccountR2ObjectRefs({
			env: input.env,
			userId: input.userId,
			dbUserId: input.dbUserId,
		}).catch((error) => {
			input.warnings.push(
				`Failed to count R2 objects: ${getErrorMessage(error)}`,
			)
			return 0
		}),
	])
	const bundleKvKeys = await listUserBundleKvKeys({
		env: input.env,
		userId: input.userId,
		sourceSnapshots,
		communityListingIds,
		warnings: input.warnings,
	}).catch((error) => {
		input.warnings.push(
			`Failed to enumerate bundle KV keys: ${getErrorMessage(error)}`,
		)
		return [] as Array<string>
	})
	const artifactRepos = sourceSnapshots.map((source) => ({
		sourceId: source.sourceId,
		entityKind: source.entityKind,
		entityId: source.entityId,
		repoId: source.repoId,
		publishedCommit: source.publishedCommit,
		manifestPath: source.manifestPath,
		sourceRoot: source.sourceRoot,
	}))
	return {
		storageIds,
		sourceSnapshots,
		savedPackages,
		communityListingIds,
		bundleKvKeys,
		r2ObjectCount,
		artifactRepos,
	}
}

async function countScalar(
	env: Env,
	sql: string,
	params: ReadonlyArray<unknown>,
) {
	const row = await env.APP_DB.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function countUserStorageIds(env: Env, userId: OwnerId) {
	// Match durable_object_summaries discovery: D1 base plus RunLog storage ids
	// (one RunLog RPC).
	const [d1Ids, runRecordStorageIds] = await Promise.all([
		listExportD1DiscoverableStorageIds(env, userId),
		listRunRecordStorageIds({ env, userId }),
	])
	const ids = new Set(d1Ids)
	for (const storageId of runRecordStorageIds) {
		ids.add(storageId)
	}
	return ids.size
}

async function countUserBundleKvKeys(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}) {
	const deterministic = await countScalar(
		input.env,
		`SELECT COUNT(*) AS count FROM (
			SELECT kv_key AS key FROM published_bundle_artifacts WHERE user_id = ?
			UNION
			SELECT 'source-snapshot:v1:' || id || ':' || published_commit
				FROM entity_sources
				WHERE user_id = ? AND published_commit IS NOT NULL
			UNION
			SELECT 'source-manifest-snapshot:v1:' || id || ':' || published_commit
				FROM entity_sources
				WHERE user_id = ? AND published_commit IS NOT NULL
			UNION
			SELECT 'community-snapshot:v1:' || id
				FROM community_listings WHERE owner_user_id = ?
		)`,
		[input.userId, input.userId, input.userId, input.userId],
	)
	if (!input.env.BUNDLE_ARTIFACTS_KV?.list) return deterministic
	let additional = 0
	let afterId = ''
	for (;;) {
		const page = await input.env.APP_DB.prepare(
			`SELECT id, published_commit
			FROM entity_sources
			WHERE user_id = ? AND id > ?${andLiveDeletedAtSql()}
			ORDER BY id LIMIT 100`,
		)
			.bind(input.userId, afterId)
			.all<{ id: string; published_commit: string | null }>()
		const rows = page.results ?? []
		if (rows.length === 0) break
		for (const source of rows) {
			for (const prefix of [
				`source-snapshot:v1:${source.id}:`,
				`source-manifest-snapshot:v1:${source.id}:`,
			]) {
				const canonical = source.published_commit
					? `${prefix}${source.published_commit}`
					: null
				let cursor: string | undefined
				do {
					try {
						const listed = await input.env.BUNDLE_ARTIFACTS_KV.list({
							prefix,
							cursor,
						})
						additional += listed.keys.filter(
							(key) => key.name !== canonical,
						).length
						cursor = listed.list_complete ? undefined : listed.cursor
					} catch (error) {
						input.warnings.push(
							`KV prefix listing failed for ${prefix}: ${getErrorMessage(error)}`,
						)
						cursor = undefined
					}
				} while (cursor)
			}
		}
		afterId = rows.at(-1)!.id
		if (rows.length < 100) break
	}
	return deterministic + additional
}

async function collectManifestInventoryCounts(input: {
	env: AccountExportEnv
	userId: OwnerId
	dbUserId: number
	warnings: Array<string>
}): Promise<ManifestInventoryCounts> {
	const safeCount = async (label: string, run: () => Promise<number>) => {
		try {
			return await run()
		} catch (error) {
			input.warnings.push(`Failed to count ${label}: ${getErrorMessage(error)}`)
			return 0
		}
	}
	const [
		storageRunners,
		runRecords,
		userMeterCounters,
		mailboxRows,
		repoSessionIndexRows,
		artifactRepos,
		kvKeys,
		r2Objects,
	] = await Promise.all([
		safeCount('storage ids', async () =>
			countUserStorageIds(input.env, input.userId),
		),
		safeCount('run records', async () => {
			const summary = await summarizeRunRecords({
				env: input.env,
				userId: input.userId,
			})
			return summary.total
		}),
		safeCount('user meter counters', async () => {
			if (!userMeterNamespace(input.env)) return 0
			const page = await userMeterRpc({
				env: input.env,
				userId: input.userId,
			}).exportCounters({
				pageSize: maxExportPageSize,
			})
			return countUserMeterExportEntries(page)
		}),
		safeCount('mailbox rows', async () => {
			const counts = await countInternalUserMailboxRows({
				env: input.env,
				ownerId: input.userId,
			})
			return (
				counts.threads +
				counts.messages +
				counts.attachments +
				counts.deliveryEvents
			)
		}),
		safeCount('repo session index rows', async () => {
			if (!repoSessionIndexNamespace(input.env)) return 0
			return await repoSessionIndexRpc({
				env: input.env,
				userId: input.userId,
			}).countAll({
				ownerId: input.userId,
			})
		}),
		safeCount('artifact repos', async () =>
			countScalar(
				input.env,
				`SELECT COUNT(*) AS count FROM entity_sources WHERE user_id = ?`,
				[input.userId],
			),
		),
		safeCount('bundle KV keys', async () => countUserBundleKvKeys(input)),
		safeCount('R2 objects', async () =>
			countAccountR2ObjectRefs({
				env: input.env,
				userId: input.userId,
				dbUserId: input.dbUserId,
			}),
		),
	])
	return {
		storageRunners,
		runRecords,
		userMeterCounters,
		mailboxRows,
		repoSessionIndexRows,
		artifactRepos,
		kvKeys,
		r2Objects,
	}
}

async function countOAuthGrants(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}) {
	const helpers = await resolveOAuthGrantReader(input.env)
	if (!helpers) {
		input.warnings.push(oauthSurfaceUnavailableWarning)
		return 0
	}
	let count = 0
	let cursor: string | undefined
	for (;;) {
		try {
			const page = await helpers.listUserGrants(input.userId, { cursor })
			count += page.items.length
			if (!page.cursor) return count
			cursor = page.cursor
		} catch (error) {
			input.warnings.push(
				`OAuth grant listing failed after ${count} grant(s): ${getErrorMessage(error)}`,
			)
			return count
		}
	}
}

// Job rows live in the jobs worker's database (ADR 0016). They are exported
// through the JOBS service contract but keep the `d1.jobs` section name for
// export-shape continuity.
const jobsWorkerExportTables = ['jobs'] as const

async function listJobsWorkerTableRows(
	env: Env,
	userId: OwnerId,
): Promise<Array<Record<string, unknown>>> {
	const rows = await jobsData(env).listJobsForUser({ userId })
	return sortRowsByDedupeKey(
		rows.map((row) => {
			const {
				record,
				callerContext,
				callerContextJson,
				schedulerWakeAt,
				...columns
			} = row
			void record
			void callerContext
			void callerContextJson
			void schedulerWakeAt
			return { ...columns }
		}),
	)
}

async function collectJobsWorkerTables(input: {
	env: AccountExportEnv
	mcpUserId: OwnerId
	warnings: Array<string>
}): Promise<Array<[string, AccountExportD1Table]>> {
	const tables: Array<[string, AccountExportD1Table]> = []
	for (const table of jobsWorkerExportTables) {
		const section: AccountExportD1Table = {
			table,
			rows: [],
			redactedColumns: [],
			warnings: [],
		}
		try {
			section.rows = await listJobsWorkerTableRows(input.env, input.mcpUserId)
		} catch (error) {
			const warning = `Jobs export failed for ${table}: ${getErrorMessage(error)}`
			section.warnings.push(warning)
			input.warnings.push(warning)
		}
		tables.push([table, section])
	}
	return tables
}

async function collectD1Tables(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: OwnerId
	personUserId: PersonId
	warnings: Array<string>
}) {
	const conditionsByTable = buildD1TableConditions({
		mcpUserId: input.mcpUserId,
		personUserId: input.personUserId,
		dbUserId: input.dbUserId,
	})
	const tables: Array<[string, AccountExportD1Table]> = []
	for (const [table, conditions] of conditionsByTable) {
		tables.push([
			table,
			await collectD1TableRows({
				env: input.env,
				table,
				conditions,
				mcpUserId: input.mcpUserId,
				personUserId: input.personUserId,
				warnings: input.warnings,
			}),
		])
	}
	tables.push(...(await collectJobsWorkerTables(input)))
	return Object.fromEntries(
		tables.sort(([left], [right]) => left.localeCompare(right)),
	)
}

async function collectD1TableCounts(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: OwnerId
	personUserId: PersonId
	warnings: Array<string>
}) {
	const conditionsByTable = buildD1TableConditions({
		mcpUserId: input.mcpUserId,
		personUserId: input.personUserId,
		dbUserId: input.dbUserId,
	})
	const sections: Array<[string, AccountExportManifestSection]> = []
	for (const [table, conditions] of conditionsByTable) {
		const where = conditions
			.map((condition) => `(${condition.condition})`)
			.join(' OR ')
		try {
			const row = await input.env.APP_DB.prepare(
				`SELECT COUNT(*) AS count FROM ${table} WHERE (${where})`,
			)
				.bind(...conditions.flatMap((condition) => condition.params))
				.first<{ count: number }>()
			const count = Number(row?.count ?? 0)
			const redactedColumns = [
				...(accountExportRedactedColumnsByTable[table] ?? []),
			].sort()
			sections.push([
				`d1.${table}`,
				{
					count,
					warnings: [],
					...(count > 0 && redactedColumns.length > 0
						? { redactedColumns }
						: {}),
				},
			])
		} catch (error) {
			const warning = `D1 export failed for ${table}: ${getErrorMessage(error)}`
			input.warnings.push(warning)
			sections.push([`d1.${table}`, { count: 0, warnings: [warning] }])
		}
	}
	for (const table of jobsWorkerExportTables) {
		try {
			const rows = await listJobsWorkerTableRows(input.env, input.mcpUserId)
			sections.push([`d1.${table}`, { count: rows.length, warnings: [] }])
		} catch (error) {
			const warning = `Jobs export failed for ${table}: ${getErrorMessage(error)}`
			input.warnings.push(warning)
			sections.push([`d1.${table}`, { count: 0, warnings: [warning] }])
		}
	}
	return Object.fromEntries(
		sections.sort(([left], [right]) => left.localeCompare(right)),
	)
}

function parseRowidCursor(startAfter: string | undefined) {
	if (!startAfter) return 0
	const parsed = Number.parseInt(startAfter, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

async function readD1TableSectionPage(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: OwnerId
	personUserId: PersonId
	table: string
	pageSize: number | undefined
	startAfter: string | undefined
	warnings: Array<string>
}) {
	const pageSize = normalizePageSize(input.pageSize)
	if (
		jobsWorkerExportTables.includes(
			input.table as (typeof jobsWorkerExportTables)[number],
		)
	) {
		try {
			const rows = await listJobsWorkerTableRows(input.env, input.mcpUserId)
			const afterIndex = parseRowidCursor(input.startAfter)
			const items = rows.slice(afterIndex, afterIndex + pageSize)
			const truncated = afterIndex + pageSize < rows.length
			return {
				items,
				truncated,
				nextStartAfter: truncated ? String(afterIndex + pageSize) : null,
				pageSize,
			}
		} catch (error) {
			input.warnings.push(
				`Jobs export failed for ${input.table}: ${getErrorMessage(error)}`,
			)
			return {
				items: [] as Array<Record<string, unknown>>,
				truncated: false,
				nextStartAfter: null,
				pageSize,
			}
		}
	}
	const conditions = buildD1TableConditions({
		mcpUserId: input.mcpUserId,
		personUserId: input.personUserId,
		dbUserId: input.dbUserId,
	}).get(input.table)
	if (!conditions) return null
	try {
		const page = await selectD1TablePage({
			env: input.env,
			table: input.table,
			conditions,
			mcpUserId: input.mcpUserId,
			personUserId: input.personUserId,
			afterRowid: parseRowidCursor(input.startAfter),
			limit: pageSize,
		})
		return {
			items: page.rows.map((entry) => entry.row),
			truncated: page.truncated,
			nextStartAfter: page.truncated ? String(page.lastRowid) : null,
			pageSize,
		}
	} catch (error) {
		input.warnings.push(
			`D1 export failed for ${input.table}: ${getErrorMessage(error)}`,
		)
		return {
			items: [] as Array<Record<string, unknown>>,
			truncated: false,
			nextStartAfter: null,
			pageSize,
		}
	}
}

async function listOAuthGrants(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}) {
	const helpers = await resolveOAuthGrantReader(input.env)
	if (!helpers) {
		input.warnings.push(oauthSurfaceUnavailableWarning)
		return [] as Array<{ id: string; clientId: string }>
	}
	const grants: Array<{ id: string; clientId: string }> = []
	let cursor: string | undefined
	while (true) {
		let page: OAuthGrantPage
		try {
			page = await helpers.listUserGrants(input.userId, { cursor })
		} catch (error) {
			input.warnings.push(
				`OAuth grant listing failed after ${grants.length} grant(s): ${getErrorMessage(error)}`,
			)
			return grants
		}
		grants.push(...page.items.map((grant) => ({ ...grant })))
		if (!page.cursor) return grants
		cursor = page.cursor
	}
}

async function exportStorageRunners(input: {
	env: AccountExportEnv
	userId: OwnerId
	storageIds: ReadonlyArray<string>
	warnings: Array<string>
}) {
	const storageRunners: AccountExportDurableObjects['storageRunners'] = []
	for (const storageId of input.storageIds) {
		try {
			const runnerExport = await storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId,
			}).exportStorage({ pageSize: maxExportPageSize })
			storageRunners.push({ storageId, export: runnerExport })
			if (runnerExport.truncated) {
				input.warnings.push(
					`Storage runner ${storageId} was truncated in the full export; use accountExportSection with section "storage_runner" and storage_id "${storageId}" to retrieve additional pages.`,
				)
			}
		} catch (error) {
			input.warnings.push(
				`Storage runner export failed for ${storageId}: ${getErrorMessage(error)}`,
			)
		}
	}
	return storageRunners
}

async function exportUserRunRecords(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}) {
	try {
		const runRecords = await exportRunRecords({
			env: input.env,
			userId: input.userId,
			pageSize: maxExportPageSize,
		})
		if (runRecords.truncated) {
			input.warnings.push(
				`Run records were truncated in the full export; use accountExportSection with section "run_records" to retrieve additional pages.`,
			)
		}
		return runRecords
	} catch (error) {
		input.warnings.push(`Run records export failed: ${getErrorMessage(error)}`)
		return null
	}
}

async function exportUserMeterCounters(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}): Promise<UserMeterExportResult | null> {
	try {
		if (!userMeterNamespace(input.env)) {
			input.warnings.push(
				'USER_METER binding was unavailable; user meter counters were not exported.',
			)
			return null
		}
		const page = await userMeterRpc({
			env: input.env,
			userId: input.userId,
		}).exportCounters({
			pageSize: maxExportPageSize,
		})
		if (page.truncated) {
			input.warnings.push(
				`User meter counters were truncated in the full export; use accountExportSection with section "user_meter" to retrieve additional pages.`,
			)
		}
		return page
	} catch (error) {
		input.warnings.push(`User meter export failed: ${getErrorMessage(error)}`)
		return null
	}
}

async function exportMailboxRows(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}): Promise<MailboxExportResult | null> {
	try {
		const page = await exportInternalUserMailbox({
			env: input.env,
			ownerId: input.userId,
			pageSize: maxExportPageSize,
		})
		if (page.truncated) {
			input.warnings.push(
				`Mailbox rows were truncated in the full export; use accountExportSection with section "mailbox" to retrieve additional pages.`,
			)
		}
		return page
	} catch (error) {
		input.warnings.push(`Mailbox export failed: ${getErrorMessage(error)}`)
		return null
	}
}

async function exportRepoSessionIndexRows(input: {
	env: AccountExportEnv
	userId: OwnerId
	warnings: Array<string>
}): Promise<RepoSessionIndexExportResult | null> {
	try {
		if (!repoSessionIndexNamespace(input.env)) {
			input.warnings.push(
				'REPO_SESSION_INDEX binding was unavailable; repo session catalog rows were omitted from the export.',
			)
			return null
		}
		const page = await repoSessionIndexRpc({
			env: input.env,
			userId: input.userId,
		}).exportSessions({
			ownerId: input.userId,
			pageSize: maxExportPageSize,
		})
		if (page.truncated) {
			input.warnings.push(
				`Repo session index rows were truncated in the full export; use accountExportSection with section "repo_session_index" to retrieve additional pages.`,
			)
		}
		return page
	} catch (error) {
		input.warnings.push(
			`Repo session index export failed: ${getErrorMessage(error)}`,
		)
		return null
	}
}

async function exportDurableObjects(input: {
	env: AccountExportEnv
	userId: OwnerId
	inventory: UserExportInventory
	warnings: Array<string>
}): Promise<AccountExportDurableObjects> {
	const [storageRunners, runRecords, userMeter, mailbox, repoSessionIndex] =
		await Promise.all([
			exportStorageRunners({
				env: input.env,
				userId: input.userId,
				storageIds: input.inventory.storageIds,
				warnings: input.warnings,
			}),
			exportUserRunRecords({
				env: input.env,
				userId: input.userId,
				warnings: input.warnings,
			}),
			exportUserMeterCounters({
				env: input.env,
				userId: input.userId,
				warnings: input.warnings,
			}),
			exportMailboxRows({
				env: input.env,
				userId: input.userId,
				warnings: input.warnings,
			}),
			exportRepoSessionIndexRows({
				env: input.env,
				userId: input.userId,
				warnings: input.warnings,
			}),
		])
	let jobManager: unknown | null = null
	try {
		jobManager = await exportJobManagerForUser({
			env: input.env,
			userId: input.userId,
		})
	} catch (error) {
		input.warnings.push(`Job manager export failed: ${getErrorMessage(error)}`)
	}
	return {
		jobManager,
		runRecords,
		userMeter,
		mailbox,
		repoSessionIndex,
		storageRunners,
	}
}

function buildManifest(input: {
	generatedAt: string
	dbUserId: number
	mcpUserId: OwnerId
	d1?: Record<string, AccountExportD1Table>
	d1Sections?: Record<string, AccountExportManifestSection>
	durableObjects?: AccountExportDurableObjects | null
	oauthGrants?: ReadonlyArray<{ id: string; clientId: string }>
	oauthGrantCount?: number
	inventory?: UserExportInventory
	inventoryCounts?: ManifestInventoryCounts
	warnings: Array<string>
}) {
	const sections: Record<string, AccountExportManifestSection> = {
		...input.d1Sections,
	}
	for (const [table, exportTable] of Object.entries(input.d1 ?? {})) {
		sections[`d1.${table}`] = {
			count: exportTable.rows.length,
			warnings: exportTable.warnings,
			...(exportTable.redactedColumns.length > 0
				? { redactedColumns: exportTable.redactedColumns }
				: {}),
		}
	}
	sections.storage_runners = {
		count:
			input.inventoryCounts?.storageRunners ??
			input.inventory?.storageIds.length ??
			0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Storage runner '),
		),
		discovery: {
			section: 'durable_object_summaries',
			kind: 'storage_runner',
		},
	}
	sections.job_manager = {
		count: 1,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Job manager '),
		),
		discovery: { section: 'job_manager' },
	}
	sections.run_records = {
		// Full exports count every RunLog table returned by exportRuns (runs,
		// ledger, and dedicated unpruned state). Manifest-only inventory falls
		// back to summarize (run rows only).
		count:
			input.durableObjects?.runRecords == null
				? (input.inventoryCounts?.runRecords ?? 0)
				: countRunRecordsExportEntries(input.durableObjects.runRecords),
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Run records '),
		),
		discovery: { section: 'run_records' },
	}
	sections.user_meter = {
		count:
			input.durableObjects?.userMeter == null
				? (input.inventoryCounts?.userMeterCounters ?? 0)
				: countUserMeterExportEntries(input.durableObjects.userMeter),
		warnings: input.warnings.filter(
			(warning) =>
				warning.startsWith('User meter ') || warning.startsWith('USER_METER '),
		),
		discovery: { section: 'user_meter' },
	}
	sections.mailbox = {
		count:
			input.durableObjects?.mailbox == null
				? (input.inventoryCounts?.mailboxRows ?? 0)
				: input.durableObjects.mailbox.rows.length,
		warnings: input.warnings.filter(
			(warning) =>
				warning.startsWith('Mailbox ') || warning.startsWith('MAILBOX '),
		),
		discovery: { section: 'mailbox' },
	}
	sections.repo_session_index = {
		count:
			input.durableObjects?.repoSessionIndex == null
				? (input.inventoryCounts?.repoSessionIndexRows ?? 0)
				: input.durableObjects.repoSessionIndex.rows.length,
		warnings: input.warnings.filter(
			(warning) =>
				warning.startsWith('Repo session index ') ||
				warning.startsWith('REPO_SESSION_INDEX '),
		),
		discovery: { section: 'repo_session_index' },
	}
	sections.oauth_grants = {
		count: input.oauthGrantCount ?? input.oauthGrants?.length ?? 0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('OAuth grant '),
		),
	}
	sections.artifact_repos = {
		count:
			input.inventoryCounts?.artifactRepos ??
			input.inventory?.artifactRepos.length ??
			0,
		warnings: [],
	}
	sections.kv_keys = {
		count:
			input.inventoryCounts?.kvKeys ??
			input.inventory?.bundleKvKeys.length ??
			0,
		warnings: input.warnings.filter((warning) => warning.startsWith('KV ')),
	}
	sections.r2_object = {
		count:
			input.inventoryCounts?.r2Objects ?? input.inventory?.r2ObjectCount ?? 0,
		warnings: input.warnings.filter((warning) => warning.includes('R2 object')),
	}
	return {
		schemaVersion: accountExportSchemaVersion,
		generatedAt: input.generatedAt,
		user: {
			dbUserId: input.dbUserId,
			userId: input.mcpUserId,
		},
		security: {
			secretValuesExported: false as const,
			note: 'Secret values, encrypted secret payloads, password hashes, token hashes, and credential-equivalent hashes are never exported. Secret entries contain metadata only.',
		},
		sections,
		warnings: input.warnings,
		chunking: {
			sections: [...accountExportSectionNames],
			defaultPageSize: defaultExportPageSize,
			maxPageSize: maxExportPageSize,
		},
		artifacts: {
			canonicalPackageSource:
				'Package/job source code is stored in Cloudflare Artifacts repos referenced by entity_sources.repo_id. This export lists repo pointers and published commits; fetch or clone those repos separately with Artifacts access rather than relying on D1 projections.',
		},
		derivedData: {
			vectorize:
				'Vectorize entries for memories, jobs, and packages are derived from exported D1 rows and are intentionally excluded; rebuild them by reindexing after import.',
			r2: 'R2 raw MIME, attachment, avatar, and icon bytes are exported through the r2_object section in bounded 256 KiB base64 chunks. Missing objects are returned explicitly instead of being silently omitted.',
		},
		excludedOperationalData: {
			email_outbound_provider_index:
				'Operational global provider→owner reverse lookup for outbound delivery webhooks. It is omitted from the D1 export payload; Mailbox messages retain provider ids, but this export does not claim or perform a fleet-wide rebuild.',
			email_outbound_failure_tracking:
				'Operational per-provider-event consecutive-failure tracking ledger for outbound pause recovery. It is omitted from the D1 export payload; orgs.email_outbound_consecutive_failures remains on the exported org row.',
			transactional_email_delivery_index:
				'Operational Cloudflare message-id → user reverse lookup for signup/verify and additional-destination verification delivery webhooks. It is omitted from the D1 export payload; users.email_verification_delivery_* columns remain on the exported user row.',
		},
		excludedDurableObjects: getAccountExportExcludedDurableObjects(),
		excludedD1Surfaces: getAccountExportExcludedD1Surfaces(),
	} satisfies AccountExportManifest
}

export function getAccountExportD1UserColumnCoverage() {
	return getAccountD1UserColumnCoverage()
}

export async function resolveAccountExportDbUserId(input: {
	env: AccountExportEnv
	personUserId: PersonId
	email?: string | null
}) {
	const email = input.email?.trim().toLowerCase()
	if (!email) {
		throw new Error('Account export requires an authenticated user email.')
	}
	const row = await input.env.APP_DB.prepare(
		`SELECT id, email, stable_user_id FROM users WHERE email = ?${andLiveDeletedAtSql()}`,
	)
		.bind(email)
		.first<{ id: number; email: string; stable_user_id: string }>()
	if (!row) {
		throw new Error('Authenticated account was not found.')
	}
	if (personIdFromStored(row.stable_user_id) !== input.personUserId) {
		throw new Error(
			'Authenticated user identity did not match the account email.',
		)
	}
	return row.id
}

export async function createAccountExportManifest(input: {
	env: AccountExportEnv
	dbUserId: number
	/**
	 * Personal org / storage owner. Prefer this over {@link mcpUserId}.
	 */
	ownerUserId?: OwnerId
	/**
	 * Person id for OAuth grants. Defaults to the same bytes as the owner id
	 * (legacy equal-id personal orgs).
	 */
	personUserId?: PersonId
	/**
	 * Backward-compatible single id: used as owner when `ownerUserId` is
	 * omitted, and as person when `personUserId` is omitted.
	 */
	mcpUserId?: OwnerId
	generatedAt?: string
}): Promise<AccountExportManifest> {
	const { ownerUserId, personUserId } = resolveAccountExportUserIds(input)
	const personKeyedOwnerId = personalOrgId(personUserId)
	const warnings: Array<string> = []
	const generatedAt = input.generatedAt ?? new Date().toISOString()
	const [d1Sections, inventoryCounts, oauthGrantCount] = await Promise.all([
		collectD1TableCounts({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: ownerUserId,
			personUserId,
			warnings,
		}),
		collectManifestInventoryCounts({
			env: input.env,
			userId: ownerUserId,
			dbUserId: input.dbUserId,
			warnings,
		}),
		countOAuthGrants({
			env: input.env,
			userId: personKeyedOwnerId,
			warnings,
		}),
	])
	return buildManifest({
		generatedAt,
		dbUserId: input.dbUserId,
		mcpUserId: ownerUserId,
		d1Sections,
		inventoryCounts,
		oauthGrantCount,
		warnings,
	})
}

export async function createAccountExport(input: {
	env: AccountExportEnv
	dbUserId: number
	ownerUserId?: OwnerId
	personUserId?: PersonId
	mcpUserId?: OwnerId
	generatedAt?: string
}): Promise<AccountExportFile> {
	const { ownerUserId, personUserId } = resolveAccountExportUserIds(input)
	const personKeyedOwnerId = personalOrgId(personUserId)
	const warnings: Array<string> = []
	const generatedAt = input.generatedAt ?? new Date().toISOString()
	const [d1, inventory, oauthGrants] = await Promise.all([
		collectD1Tables({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: ownerUserId,
			personUserId,
			warnings,
		}),
		collectInventory({
			env: input.env,
			userId: ownerUserId,
			dbUserId: input.dbUserId,
			warnings,
		}),
		listOAuthGrants({
			env: input.env,
			userId: personKeyedOwnerId,
			warnings,
		}),
	])
	const durableObjects = await exportDurableObjects({
		env: input.env,
		userId: ownerUserId,
		inventory,
		warnings,
	})
	return {
		manifest: buildManifest({
			generatedAt,
			dbUserId: input.dbUserId,
			mcpUserId: ownerUserId,
			d1,
			durableObjects,
			oauthGrants,
			inventory,
			warnings,
		}),
		d1,
		durableObjects,
		oauthGrants,
		artifactRepos: inventory.artifactRepos,
		kvKeys: inventory.bundleKvKeys,
	}
}

async function readR2ObjectSection(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: OwnerId
	startAfter: string | undefined
	warnings: Array<string>
}): Promise<AccountExportSectionResult> {
	const page = await readAccountR2ExportPage({
		env: input.env,
		userId: input.mcpUserId,
		dbUserId: input.dbUserId,
		startAfter: input.startAfter,
		warnings: input.warnings,
	})
	return {
		section: 'r2_object',
		...page,
		pageSize: 1,
		warnings: input.warnings,
	}
}

export async function readAccountExportSection(input: {
	env: AccountExportEnv
	dbUserId: number
	ownerUserId?: OwnerId
	personUserId?: PersonId
	mcpUserId?: OwnerId
	section: AccountExportSectionName
	table?: string
	storageId?: string
	kind?: 'storage_runner' | 'job_manager'
	pageSize?: number
	startAfter?: string
}): Promise<AccountExportSectionResult> {
	const { ownerUserId, personUserId } = resolveAccountExportUserIds(input)
	const personKeyedOwnerId = personalOrgId(personUserId)
	const warnings: Array<string> = []
	if (input.section === 'r2_object') {
		return await readR2ObjectSection({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: ownerUserId,
			startAfter: input.startAfter,
			warnings,
		})
	}
	if (input.section === 'storage_runner') {
		if (!input.storageId) {
			throw new Error('storage_id is required when section is storage_runner.')
		}
		const storageOwned = await isExportDiscoverableStorageId(
			input.env,
			ownerUserId,
			input.storageId,
		)
		if (!storageOwned) {
			throw new Error('Storage runner was not found for account export.')
		}
		const pageSize = normalizePageSize(input.pageSize)
		const runnerExport = await storageRunnerRpc({
			env: input.env,
			userId: ownerUserId,
			storageId: input.storageId,
		}).exportStorage({
			pageSize,
			startAfter: input.startAfter,
		})
		return {
			section: input.section,
			items: runnerExport.entries,
			truncated: runnerExport.truncated,
			nextStartAfter: runnerExport.nextStartAfter,
			pageSize: runnerExport.pageSize,
			warnings,
		}
	}
	if (input.section === 'job_manager') {
		return {
			section: input.section,
			items: [
				await exportJobManagerForUser({
					env: input.env,
					userId: ownerUserId,
				}),
			],
			truncated: false,
			nextStartAfter: null,
			pageSize: 1,
			warnings,
		}
	}
	if (input.section === 'run_records') {
		const pageSize = normalizePageSize(input.pageSize)
		const page = await exportRunRecords({
			env: input.env,
			userId: ownerUserId,
			pageSize,
			startAfter: input.startAfter,
		})
		return {
			section: input.section,
			// One cursor pages runs, then ledger rows, then dedicated unpruned
			// RunLog state (workflow projections, job-run observability, package
			// run successes, activation milestones). Raw run-id cursors remain
			// valid; later phases use prefixed cursors from exportRuns.
			items: formatRunRecordsExportSectionItems(page),
			truncated: page.truncated,
			nextStartAfter: page.nextStartAfter,
			pageSize,
			warnings,
		}
	}
	if (input.section === 'user_meter') {
		if (!userMeterNamespace(input.env)) {
			throw new Error('USER_METER binding was unavailable.')
		}
		const pageSize = normalizePageSize(input.pageSize)
		const page = await userMeterRpc({
			env: input.env,
			userId: ownerUserId,
		}).exportCounters({
			pageSize,
			startAfter: input.startAfter ?? null,
		})
		return {
			section: input.section,
			items: page.counters,
			storageBytesState: page.storageBytesState,
			deletionState: page.deletionState,
			inboundConnectionLastUsed: page.inboundConnectionLastUsed,
			truncated: page.truncated,
			nextStartAfter: page.nextStartAfter,
			pageSize,
			warnings,
		}
	}
	if (input.section === 'mailbox') {
		const pageSize = normalizePageSize(input.pageSize)
		const page = await exportInternalUserMailbox({
			env: input.env,
			ownerId: ownerUserId,
			pageSize,
			startAfter: input.startAfter ?? null,
		})
		return {
			section: input.section,
			items: page.rows,
			truncated: page.truncated,
			nextStartAfter: page.nextStartAfter,
			pageSize,
			warnings,
		}
	}
	if (input.section === 'repo_session_index') {
		if (!repoSessionIndexNamespace(input.env)) {
			throw new Error('REPO_SESSION_INDEX binding was unavailable.')
		}
		const pageSize = normalizePageSize(input.pageSize)
		const page = await repoSessionIndexRpc({
			env: input.env,
			userId: ownerUserId,
		}).exportSessions({
			ownerId: ownerUserId,
			pageSize,
			startAfter: input.startAfter ?? null,
		})
		return {
			section: input.section,
			items: page.rows,
			truncated: page.truncated,
			nextStartAfter: page.nextStartAfter,
			pageSize,
			warnings,
		}
	}
	let items: Array<unknown>
	switch (input.section) {
		case 'd1_table': {
			if (!input.table) {
				throw new Error('table is required when section is d1_table.')
			}
			const page = await readD1TableSectionPage({
				env: input.env,
				dbUserId: input.dbUserId,
				mcpUserId: ownerUserId,
				personUserId,
				table: input.table,
				pageSize: input.pageSize,
				startAfter: input.startAfter,
				warnings,
			})
			if (!page) {
				throw new Error(`Table "${input.table}" is not part of account export.`)
			}
			return {
				section: input.section,
				...page,
				warnings,
			}
		}
		case 'oauth_grants': {
			const oauthGrants = await listOAuthGrants({
				env: input.env,
				userId: personKeyedOwnerId,
				warnings,
			})
			items = [...oauthGrants]
			break
		}
		case 'artifact_repos': {
			const inventory = await collectInventory({
				env: input.env,
				userId: ownerUserId,
				dbUserId: input.dbUserId,
				warnings,
			})
			items = inventory.artifactRepos
			break
		}
		case 'kv_keys': {
			const inventory = await collectInventory({
				env: input.env,
				userId: ownerUserId,
				dbUserId: input.dbUserId,
				warnings,
			})
			items = inventory.bundleKvKeys
			break
		}
		case 'durable_object_summaries': {
			if (!input.kind) {
				throw new Error(
					'kind is required when section is durable_object_summaries.',
				)
			}
			const pageSize = normalizePageSize(input.pageSize)
			const cursor = input.startAfter
				? (JSON.parse(input.startAfter) as Record<string, unknown>)
				: {}
			if (input.kind === 'job_manager') {
				return {
					section: input.section,
					items: cursor['done']
						? []
						: [{ kind: 'job_manager', userId: ownerUserId }],
					truncated: false,
					nextStartAfter: null,
					pageSize: 1,
					warnings,
				}
			}
			// Discovery pages use D1 keyset SQL for registered storage ids, then
			// include RunLog-only ids with one Durable Object RPC per request.
			const stage = String(cursor['stage'] ?? 'base')
			if (stage === 'base') {
				const afterId = String(cursor['afterId'] ?? '')
				const { ids: selected, truncated } = await listExportBaseStorageIdPage(
					input.env,
					ownerUserId,
					afterId,
					pageSize,
				)
				return {
					section: input.section,
					items: selected.map((id) => ({
						kind: input.kind,
						storageId: id,
					})),
					truncated: true,
					nextStartAfter: JSON.stringify(
						truncated
							? { stage: 'base', afterId: selected.at(-1)! }
							: { stage: 'runlog', afterId: '' },
					),
					pageSize,
					warnings,
				}
			}
			if (stage === 'runlog') {
				const afterId = String(cursor['afterId'] ?? '')
				const [d1Ids, runRecordStorageIds] = await Promise.all([
					listExportD1DiscoverableStorageIds(input.env, ownerUserId),
					listRunRecordStorageIds({
						env: input.env,
						userId: ownerUserId,
					}),
				])
				const exclusive = runRecordStorageIds
					.filter((storageId) => !d1Ids.has(storageId))
					.sort((left, right) => left.localeCompare(right))
				const pageRows = exclusive.filter((storageId) => storageId > afterId)
				const truncated = pageRows.length > pageSize
				const selected = truncated ? pageRows.slice(0, pageSize) : pageRows
				return {
					section: input.section,
					items: selected.map((storageId) => ({
						kind: input.kind,
						storageId,
					})),
					truncated,
					nextStartAfter: truncated
						? JSON.stringify({
								stage: 'runlog',
								afterId: selected.at(-1)!,
							})
						: null,
					pageSize,
					warnings,
				}
			}
			throw new Error(
				`Unknown durable_object_summaries storage_runner stage: ${stage}`,
			)
		}
		default: {
			const exhaustive: never = input.section
			throw new Error(`Unhandled account export section: ${exhaustive}`)
		}
	}
	const page = paginateItems({
		items,
		pageSize: input.pageSize,
		startAfter: input.startAfter,
	})
	return {
		section: input.section,
		...page,
		warnings,
	}
}
