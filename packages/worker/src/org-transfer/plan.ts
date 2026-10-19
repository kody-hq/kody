import { type JobRow } from '@kody-internal/shared/jobs/repo.ts'
import { createJobStorageId } from '@kody-internal/shared/jobs/storage-id.ts'
import {
	buildPackageStorageId,
	packageIdFromStorageId,
} from '#worker/storage-ids.ts'
import { userOauthAppLogoR2KeyPrefix } from '#worker/integrations/user-oauth-app-logo.ts'
import { mcpServerLogoR2KeyPrefix } from '#worker/mcp-client/mcp-server-logo.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { type OrgTransferFinding } from './findings.ts'
import {
	type OrgTransferOrg,
	type OrgTransferOwnerTable,
	type OrgTransferRow,
	type OrgTransferSnapshot,
} from './snapshot.ts'

export type OrgTransferOrphanCleanup =
	/** Normal per-row soft delete (sets deleted_at). */
	| 'soft-delete'
	/** Hard delete of a row with no soft-delete column and no side storage. */
	| 'delete'
	/** `deleteEntitySourceWithArtifacts` (artifact repo, bundles, snapshot). */
	| 'entity-source'
	/**
	 * Clear the StorageRunner, then hard delete the inventory row, like
	 * package delete. A soft-deleted row would keep holding its primary key.
	 */
	| 'storage-bucket'

export type OrgTransferOrphan = {
	table: string
	row: OrgTransferRow
	/** Row id or natural key, for the report. */
	key: string
	reason: string
	cleanup: OrgTransferOrphanCleanup
}

export type OrgTransferMovedTable = OrgTransferOwnerTable | 'secret_entries'

export type OrgTransferStorageCopy = {
	storageId: string
	kind: 'package' | 'job'
}

export type OrgTransferLogoCopy = {
	table: 'user_oauth_apps' | 'mcp_server_settings'
	rowid: number
	fromKey: string
	toKey: string
}

export type OrgTransferPlan = {
	from: OrgTransferOrg
	to: OrgTransferOrg
	/** Rows re-pointed to the target owner, by table. */
	moves: Record<OrgTransferMovedTable, Array<OrgTransferRow>>
	/** Source bucket id → existing target bucket id (same scope and binding). */
	bucketMerges: {
		secret_buckets: Map<string, string>
	}
	/** Scope and binding of every moved or merged source bucket, by id. */
	bucketBindings: Map<string, { scope: string; bindingKey: string }>
	/** Derived rows deleted in the batch and rebuilt by the reindex. */
	derivedDeletes: {
		saved_package_search_index_debt: Array<OrgTransferRow>
		vector_embed_fingerprints: Array<OrgTransferRow>
	}
	jobs: Array<JobRow>
	storageCopies: Array<OrgTransferStorageCopy>
	logoCopies: Array<OrgTransferLogoCopy>
	orphans: Array<OrgTransferOrphan>
	/** Person ids with a live membership in the target org. */
	targetMemberIds: ReadonlySet<string>
	clashes: Array<OrgTransferFinding>
	blockers: Array<OrgTransferFinding>
	warnings: Array<OrgTransferFinding>
	/**
	 * Live memories owned by the source. Reported so an operator sees they
	 * stay; the transfer never re-points, deletes, or reindexes them.
	 */
	kept: {
		memories: { count: number }
	}
}

const movedTables: ReadonlyArray<OrgTransferMovedTable> = [
	'saved_packages',
	// Kept empty: approvals for moved packages are orphan-deleted (re-approve).
	'package_capability_approvals',
	// Kept empty: audits for moved packages are orphan-deleted (re-audit).
	'package_security_audits',
	// Kept empty: requests for moved packages are orphan-deleted.
	'package_approval_requests',
	'user_repos',
	'entity_sources',
	'published_bundle_artifacts',
	'entity_source_artifacts_push_subscriptions',
	'community_listings',
	'community_forks',
	'mcp_server_settings',
	'mcp_user_server_instructions',
	'user_oauth_apps',
	'user_integrations',
	'secret_buckets',
	'secret_entries',
	'secret_provider_bindings',
	'secret_provider_grants',
	'user_storage_buckets',
	'webhook_endpoints',
	'webhook_apply_destination_grants',
	'webhook_apply_destination_pending',
	'package_kody_id_redirects',
	'package_slug_redirects',
	'enablements',
]

export function isLiveRow(row: OrgTransferRow) {
	return row['deleted_at'] == null && row['deleting_at'] == null
}

function text(row: OrgTransferRow, column: string) {
	const value = row[column]
	return value == null ? '' : String(value)
}

export function transferredPackageName(row: OrgTransferRow, toSlug: string) {
	return `@${toSlug}/${text(row, 'kody_id')}`
}

function keyOf(row: OrgTransferRow, columns: ReadonlyArray<string>) {
	return JSON.stringify(columns.map((column) => row[column] ?? null))
}

function rewriteOwnerLogoKey(input: {
	key: string
	prefix: string
	fromId: string
	toId: string
}) {
	const ownerPrefix = `${input.prefix}${input.fromId}/`
	if (!input.key.startsWith(ownerPrefix)) return null
	return `${input.prefix}${input.toId}/${input.key.slice(ownerPrefix.length)}`
}

/**
 * Decide what moves, what clashes, and what is orphaned. Pure over the
 * snapshot so dry-run and apply agree and tests can drive it directly.
 */
export function planOrgTransfer(
	snapshot: OrgTransferSnapshot,
): OrgTransferPlan {
	const { source, target, from, to } = snapshot
	const moves = Object.fromEntries(
		movedTables.map((table) => [table, [] as Array<OrgTransferRow>]),
	) as OrgTransferPlan['moves']
	const orphans: Array<OrgTransferOrphan> = []
	const clashes: Array<OrgTransferFinding> = []
	const blockers: Array<OrgTransferFinding> = []
	const warnings: Array<OrgTransferFinding> = []
	const orphan = (
		table: string,
		row: OrgTransferRow,
		key: string,
		reason: string,
		cleanup: OrgTransferOrphanCleanup,
	) => orphans.push({ table, row, key, reason, cleanup })

	const targetKeys = (
		table: OrgTransferOwnerTable,
		columns: ReadonlyArray<string>,
		filter: (row: OrgTransferRow) => boolean = () => true,
	) => new Set(target[table].filter(filter).map((row) => keyOf(row, columns)))
	const clashIf = (
		table: OrgTransferOwnerTable,
		rows: Array<OrgTransferRow>,
		columns: ReadonlyArray<string>,
		label: (row: OrgTransferRow) => string,
		options: {
			sourceKey?: (row: OrgTransferRow) => string
			targetFilter?: (row: OrgTransferRow) => boolean
		} = {},
	) => {
		const taken = targetKeys(table, columns, options.targetFilter)
		for (const row of rows) {
			const key = options.sourceKey?.(row) ?? keyOf(row, columns)
			if (taken.has(key)) {
				const subject = label(row)
				clashes.push({
					code: 'target_row_exists',
					message: `${table}: ${subject} already exists in @${to.slug}`,
					table,
					subject,
				})
			}
		}
	}

	// Packages, repos, and their sources.
	moves.saved_packages = source.saved_packages.filter(isLiveRow)
	const packageIds = new Set(moves.saved_packages.map((row) => text(row, 'id')))
	const packageById = new Map(
		moves.saved_packages.map((row) => [text(row, 'id'), row]),
	)
	const packageLabel = (packageId: string) =>
		packageById.get(packageId)
			? text(packageById.get(packageId)!, 'kody_id')
			: packageId
	clashIf(
		'saved_packages',
		moves.saved_packages,
		['name'],
		(row) => transferredPackageName(row, to.slug),
		{
			sourceKey: (row) =>
				JSON.stringify([transferredPackageName(row, to.slug)]),
		},
	)
	clashIf('saved_packages', moves.saved_packages, ['kody_id'], (row) =>
		text(row, 'kody_id'),
	)

	moves.user_repos = source.user_repos.filter(isLiveRow)
	const repoIds = new Set(moves.user_repos.map((row) => text(row, 'id')))
	clashIf('user_repos', moves.user_repos, ['name'], (row) => text(row, 'name'))

	for (const row of source.entity_sources.filter(isLiveRow)) {
		const kind = text(row, 'entity_kind')
		const entityId = text(row, 'entity_id')
		if (kind === 'package' && packageIds.has(entityId)) {
			moves.entity_sources.push(row)
		} else if (kind === 'repo' && repoIds.has(entityId)) {
			moves.entity_sources.push(row)
		} else {
			orphan(
				'entity_sources',
				row,
				text(row, 'id'),
				`${kind} ${entityId} no longer exists`,
				'entity-source',
			)
		}
	}
	const sourceIds = new Set(moves.entity_sources.map((row) => text(row, 'id')))
	const orphanSourceIds = new Set(
		orphans
			.filter((entry) => entry.table === 'entity_sources')
			.map((entry) => entry.key),
	)
	clashIf(
		'entity_sources',
		moves.entity_sources,
		['entity_kind', 'entity_id'],
		(row) => `${text(row, 'entity_kind')} source ${text(row, 'entity_id')}`,
	)
	for (const pkg of moves.saved_packages) {
		if (!sourceIds.has(text(pkg, 'source_id'))) {
			warnings.push({
				code: 'package_source_missing',
				message: `Package ${text(pkg, 'kody_id')} has no live source; it moves but cannot load until republished.`,
				table: 'saved_packages',
				subject: text(pkg, 'kody_id'),
			})
		}
	}

	for (const table of [
		'published_bundle_artifacts',
		'entity_source_artifacts_push_subscriptions',
	] as const) {
		for (const row of source[table]) {
			const sourceId = text(row, 'source_id')
			if (sourceIds.has(sourceId)) moves[table].push(row)
			else if (!orphanSourceIds.has(sourceId)) {
				orphan(
					table,
					row,
					sourceId,
					`source ${sourceId} no longer exists`,
					'delete',
				)
			}
		}
	}

	// Community.
	for (const row of source.community_listings.filter(isLiveRow)) {
		if (packageIds.has(text(row, 'package_id'))) {
			moves.community_listings.push(row)
		} else {
			orphan(
				'community_listings',
				row,
				text(row, 'id'),
				`package ${text(row, 'package_id')} no longer exists`,
				'soft-delete',
			)
		}
	}
	clashIf(
		'community_listings',
		moves.community_listings,
		['package_id'],
		(row) => `listing for ${text(row, 'kody_id')}`,
	)
	clashIf(
		'community_listings',
		moves.community_listings.filter((row) => text(row, 'status') === 'active'),
		['kody_id'],
		(row) => `active listing ${text(row, 'kody_id')}`,
		{ targetFilter: (row) => text(row, 'status') === 'active' },
	)
	for (const row of source.community_forks) {
		const forked = text(row, 'forked_package_id')
		if (packageIds.has(forked)) moves.community_forks.push(row)
		else {
			orphan(
				'community_forks',
				row,
				text(row, 'id'),
				`forked package ${forked} no longer exists`,
				'delete',
			)
		}
	}

	// Memories stay with the source owner. The snapshot only counts live rows;
	// nothing here re-points them, orphan-deletes suppressions, or reindexes
	// memory vectors.

	// Connectors and credentials.
	moves.mcp_server_settings = source.mcp_server_settings.filter(isLiveRow)
	clashIf('mcp_server_settings', moves.mcp_server_settings, ['name'], (row) =>
		text(row, 'name'),
	)
	for (const row of moves.mcp_server_settings) {
		const serverId = text(row, 'id')
		if (!snapshot.hubServerIds.from.has(serverId)) {
			blockers.push({
				code: 'source_hub_missing_mcp_server',
				message: `MCP server ${text(row, 'name')} has no connection in @${from.slug}'s hub; reconnect or remove it first.`,
				table: 'mcp_server_settings',
				subject: text(row, 'name'),
			})
		}
		if (snapshot.hubServerIds.to.has(serverId)) {
			clashes.push({
				code: 'target_hub_has_mcp_server',
				message: `mcp_server_settings: server id of ${text(row, 'name')} is already registered in @${to.slug}'s hub`,
				table: 'mcp_server_settings',
				subject: text(row, 'name'),
			})
		}
	}
	moves.mcp_user_server_instructions =
		source.mcp_user_server_instructions.filter(isLiveRow)
	if (
		moves.mcp_user_server_instructions.length > 0 &&
		target.mcp_user_server_instructions.length > 0
	) {
		clashes.push({
			code: 'target_mcp_instructions_exist',
			message: `mcp_user_server_instructions: @${to.slug} already has MCP server instructions`,
			table: 'mcp_user_server_instructions',
		})
	}
	moves.user_oauth_apps = source.user_oauth_apps.filter(isLiveRow)
	const oauthAppSlugs = new Set(
		moves.user_oauth_apps.map((row) => text(row, 'slug')),
	)
	clashIf('user_oauth_apps', moves.user_oauth_apps, ['slug'], (row) =>
		text(row, 'slug'),
	)
	moves.user_integrations = source.user_integrations.filter(isLiveRow)
	clashIf('user_integrations', moves.user_integrations, ['name'], (row) =>
		text(row, 'name'),
	)
	for (const row of moves.user_integrations) {
		const appSlug = row['app_slug']
		if (appSlug != null && !oauthAppSlugs.has(String(appSlug))) {
			blockers.push({
				code: 'integration_oauth_app_not_live',
				message: `Integration ${text(row, 'name')} uses OAuth app ${String(appSlug)}, which is not live in @${from.slug}.`,
				table: 'user_integrations',
				subject: text(row, 'name'),
			})
		}
	}

	// Secret buckets: move, merge, or orphan.
	const bucketMerges: OrgTransferPlan['bucketMerges'] = {
		secret_buckets: new Map(),
	}
	const bucketBindings: OrgTransferPlan['bucketBindings'] = new Map()
	for (const [bucketTable, entryTable, ownedScope] of [
		['secret_buckets', 'secret_entries', 'package'],
	] as const) {
		const targetBuckets = new Map(
			target[bucketTable].map((row) => [
				keyOf(row, ['scope', 'binding_key']),
				row,
			]),
		)
		const movedBucketIds = new Set<string>()
		for (const row of source[bucketTable].filter(isLiveRow)) {
			const scope = text(row, 'scope')
			const bindingKey = text(row, 'binding_key')
			if (scope === 'session') continue
			if (scope === ownedScope && !packageIds.has(bindingKey)) {
				orphan(
					bucketTable,
					row,
					`${scope}:${bindingKey}`,
					`package ${bindingKey} no longer exists`,
					'soft-delete',
				)
				continue
			}
			const label = scope === 'user' ? 'user' : packageLabel(bindingKey)
			const existing = targetBuckets.get(keyOf(row, ['scope', 'binding_key']))
			if (existing && !isLiveRow(existing)) {
				clashes.push({
					code: 'target_bucket_deleted_not_purged',
					message: `${bucketTable}: ${label} bucket in @${to.slug} is deleted but not purged`,
					table: bucketTable,
					subject: label,
				})
				continue
			}
			movedBucketIds.add(text(row, 'id'))
			bucketBindings.set(text(row, 'id'), { scope, bindingKey })
			if (existing) {
				bucketMerges[bucketTable].set(text(row, 'id'), text(existing, 'id'))
			} else {
				moves[bucketTable].push(row)
			}
		}
		const targetEntryNames = new Set(
			target[entryTable].map((row) => keyOf(row, ['bucket_id', 'name'])),
		)
		const bucketById = new Map(
			source[bucketTable].map((row) => [text(row, 'id'), row]),
		)
		for (const row of source[entryTable]) {
			const bucketId = text(row, 'bucket_id')
			if (!movedBucketIds.has(bucketId) || !isLiveRow(row)) continue
			moves[entryTable].push(row)
			const mergeInto = bucketMerges[bucketTable].get(bucketId)
			if (
				mergeInto &&
				targetEntryNames.has(JSON.stringify([mergeInto, row['name']]))
			) {
				const bucket = bucketById.get(bucketId)!
				const scope = text(bucket, 'scope')
				const label =
					scope === 'user' ? 'user' : packageLabel(text(bucket, 'binding_key'))
				clashes.push({
					code: 'target_entry_exists',
					message: `${entryTable}: ${label} ${text(row, 'name')} already exists in @${to.slug}`,
					table: entryTable,
					subject: `${label} ${text(row, 'name')}`,
				})
			}
		}
	}

	for (const row of source.secret_provider_bindings.filter(isLiveRow)) {
		const packageId = row['package_id']
		if (packageId == null || packageIds.has(String(packageId))) {
			moves.secret_provider_bindings.push(row)
		} else {
			orphan(
				'secret_provider_bindings',
				row,
				text(row, 'provider_id'),
				`package ${String(packageId)} no longer exists`,
				'soft-delete',
			)
		}
	}
	clashIf(
		'secret_provider_bindings',
		moves.secret_provider_bindings,
		['provider_id'],
		(row) => `secret provider ${text(row, 'provider_id')}`,
	)
	const movedProviderIds = new Set(
		moves.secret_provider_bindings.map((row) => text(row, 'provider_id')),
	)
	for (const row of source.secret_provider_grants) {
		if (
			movedProviderIds.has(text(row, 'provider_id')) &&
			packageIds.has(text(row, 'package_id'))
		) {
			moves.secret_provider_grants.push(row)
		} else {
			orphan(
				'secret_provider_grants',
				row,
				`${text(row, 'provider_id')}:${text(row, 'canonical_ref')}`,
				'binding or package no longer exists',
				'delete',
			)
		}
	}

	// Jobs of moved packages; their storage moves with them.
	const jobs: Array<JobRow> = []
	for (const job of snapshot.sourceJobs) {
		if (sourceIds.has(job.record.sourceId)) jobs.push(job)
		else {
			warnings.push({
				code: 'job_source_missing',
				message: `Job ${job.record.name} has no live source and stays.`,
				table: 'jobs',
				subject: job.record.name,
			})
		}
	}
	const jobStorageIds = new Set(
		jobs.map((job) => job.record.storageId ?? createJobStorageId(job.id)),
	)

	const storageCopies: Array<OrgTransferStorageCopy> = []
	for (const row of source.user_storage_buckets.filter(isLiveRow)) {
		const storageId = text(row, 'storage_id')
		const kind = text(row, 'kind')
		if (kind === 'package') {
			const packageId = packageIdFromStorageId(storageId)
			if (packageId && packageIds.has(packageId)) {
				moves.user_storage_buckets.push(row)
				storageCopies.push({ storageId, kind: 'package' })
			} else {
				orphan(
					'user_storage_buckets',
					row,
					storageId,
					`package ${packageId ?? storageId} no longer exists`,
					'storage-bucket',
				)
			}
		} else if (kind === 'job' && jobStorageIds.has(storageId)) {
			moves.user_storage_buckets.push(row)
			storageCopies.push({ storageId, kind: 'job' })
		}
	}
	// Storage a moved package or job may hold without a registered bucket row.
	const copiedStorageIds = new Set(storageCopies.map((copy) => copy.storageId))
	for (const [storageId, kind] of [
		...[...packageIds].map(
			(id) => [buildPackageStorageId(id), 'package'] as const,
		),
		...[...jobStorageIds].map((id) => [id, 'job'] as const),
	]) {
		if (copiedStorageIds.has(storageId)) continue
		copiedStorageIds.add(storageId)
		storageCopies.push({ storageId, kind })
	}
	clashIf(
		'user_storage_buckets',
		moves.user_storage_buckets,
		['storage_id'],
		(row) => `storage ${text(row, 'storage_id')}`,
	)

	// Webhooks.
	for (const row of source.webhook_endpoints.filter(isLiveRow)) {
		if (packageIds.has(text(row, 'package_id'))) {
			moves.webhook_endpoints.push(row)
		} else {
			orphan(
				'webhook_endpoints',
				row,
				text(row, 'id'),
				`package ${text(row, 'package_id')} no longer exists`,
				'soft-delete',
			)
		}
	}
	clashIf(
		'webhook_endpoints',
		moves.webhook_endpoints,
		['package_id', 'webhook_name'],
		(row) =>
			`webhook ${packageLabel(text(row, 'package_id'))}/${text(row, 'webhook_name')}`,
	)
	const endpointIds = new Set(
		moves.webhook_endpoints.map((row) => text(row, 'id')),
	)
	for (const table of [
		'webhook_apply_destination_grants',
		'webhook_apply_destination_pending',
	] as const) {
		moves[table] = source[table].filter((row) =>
			endpointIds.has(text(row, 'webhook_endpoint_id')),
		)
	}

	for (const [table, keyColumn] of [
		['package_kody_id_redirects', 'old_kody_id'],
		['package_slug_redirects', 'old_slug'],
	] as const) {
		for (const row of source[table]) {
			if (packageIds.has(text(row, 'package_id'))) moves[table].push(row)
			else {
				orphan(
					table,
					row,
					text(row, keyColumn),
					'package no longer exists',
					'delete',
				)
			}
		}
		clashIf(table, moves[table], [keyColumn], (row) => text(row, keyColumn))
	}

	for (const row of source.package_capability_approvals) {
		if (packageIds.has(text(row, 'package_id'))) {
			orphan(
				'package_capability_approvals',
				row,
				text(row, 'id'),
				'internet-visible approval must be re-attested by the destination owner',
				'delete',
			)
		} else {
			orphan(
				'package_capability_approvals',
				row,
				text(row, 'id'),
				'package no longer exists',
				'delete',
			)
		}
	}

	for (const row of source.package_security_audits) {
		orphan(
			'package_security_audits',
			row,
			text(row, 'id'),
			packageIds.has(text(row, 'package_id'))
				? 'security audits describe the source owner review; the destination owner can re-audit'
				: 'package no longer exists',
			'delete',
		)
	}

	for (const row of source.package_approval_requests) {
		orphan(
			'package_approval_requests',
			row,
			text(row, 'id'),
			packageIds.has(text(row, 'package_id'))
				? 'approval request is addressed to the source owner'
				: 'package no longer exists',
			'delete',
		)
	}

	// Enablements and grants (org-keyed).
	for (const row of source.enablements) {
		if (!packageIds.has(text(row, 'package_id'))) continue
		moves.enablements.push(row)
		const enabler = text(row, 'enabler_user_id')
		if (text(row, 'state') !== 'off' && !snapshot.targetMembers.has(enabler)) {
			const subject = `${packageLabel(text(row, 'package_id'))} ${text(row, 'trigger_kind')}:${text(row, 'trigger_name')}`
			blockers.push({
				code: 'enabler_not_target_member',
				message: `Enablement ${text(row, 'trigger_kind')}:${text(row, 'trigger_name')} of ${packageLabel(text(row, 'package_id'))} is enabled by ${enabler}, who is not a member of @${to.slug}.`,
				table: 'enablements',
				subject,
			})
		}
	}
	for (const row of source.grants.filter(isLiveRow)) {
		if (text(row, 'resource_type') === 'org') continue
		blockers.push({
			code: 'grant_names_source_subjects',
			message: `Grant ${text(row, 'id')} on ${text(row, 'resource_type')} ${text(row, 'resource_id')} names @${from.slug} subjects; remove it before transferring.`,
			table: 'grants',
			subject: text(row, 'id'),
		})
	}

	for (const table of [
		'secret_entries',
		'user_integrations',
		'mcp_server_settings',
	] as const) {
		for (const row of moves[table]) {
			if (!snapshot.personalGrantCredentialIds.has(text(row, 'id'))) continue
			blockers.push({
				code: 'personal_credential_granted_to_org',
				message: `${table} ${text(row, 'name')} is granted to other orgs as a personal credential; revoke those grants before transferring.`,
				table,
				subject: text(row, 'id'),
			})
		}
	}

	// Derived rows rebuilt under the target.
	const movedVectorIds = new Set([
		...[...packageIds].map(savedPackageVectorId),
		...jobs.map((job) => jobVectorId(job.id)),
	])

	const logoCopies: Array<OrgTransferLogoCopy> = []
	for (const [table, prefix] of [
		['user_oauth_apps', userOauthAppLogoR2KeyPrefix],
		['mcp_server_settings', mcpServerLogoR2KeyPrefix],
	] as const) {
		for (const row of moves[table]) {
			const fromKey = row['logo_key']
			if (typeof fromKey !== 'string' || !fromKey) continue
			const toKey = rewriteOwnerLogoKey({
				key: fromKey,
				prefix,
				fromId: from.id,
				toId: to.id,
			})
			if (toKey) logoCopies.push({ table, rowid: row.__rowid, fromKey, toKey })
		}
	}

	return {
		from,
		to,
		moves,
		bucketMerges,
		bucketBindings,
		derivedDeletes: {
			saved_package_search_index_debt:
				source.saved_package_search_index_debt.filter((row) =>
					packageIds.has(text(row, 'package_id')),
				),
			vector_embed_fingerprints: source.vector_embed_fingerprints.filter(
				(row) => movedVectorIds.has(text(row, 'vector_id')),
			),
		},
		jobs,
		storageCopies,
		logoCopies,
		orphans,
		targetMemberIds: new Set(snapshot.targetMembers.keys()),
		clashes,
		blockers,
		warnings,
		kept: {
			memories: { count: snapshot.sourceLiveMemoryCount },
		},
	}
}
