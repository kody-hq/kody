/**
 * soft-delete-read-filter: opt-out
 *
 * Builds the single APP_DB batch that re-points an org's resources. Rows are
 * addressed by the rowids the plan read, and every statement also matches
 * the source owner, so a row changed after planning is left alone and shows
 * up in the post-commit leftover check instead of being overwritten.
 */

import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import {
	type OrgTransferMovedTable,
	type OrgTransferOrphan,
	type OrgTransferPlan,
	transferredPackageName,
} from './plan.ts'
import { type OrgTransferSealedColumns, sealedRowKey } from './reencrypt.ts'
import { orgTransferOwnerTables, type OrgTransferRow } from './snapshot.ts'

const rowidChunkSize = 500

/** Tables re-pointed by owner column with no other column rewritten. */
export const orgTransferRepointedTables = [
	'user_repos',
	'entity_sources',
	'published_bundle_artifacts',
	'entity_source_artifacts_push_subscriptions',
	'community_forks',
	'mcp_server_settings',
	'mcp_user_server_instructions',
	'secret_buckets',
	'secret_provider_bindings',
	'secret_provider_grants',
	'user_storage_buckets',
	'webhook_apply_destination_grants',
	'webhook_apply_destination_pending',
	'package_kody_id_redirects',
	'package_slug_redirects',
	'enablements',
] as const satisfies ReadonlyArray<OrgTransferMovedTable>

/** Tables rewritten row by row (owner plus rewritten columns). */
export const orgTransferRewrittenTables = [
	'saved_packages',
	'community_listings',
	'user_oauth_apps',
	'user_integrations',
	'webhook_endpoints',
	'secret_entries',
] as const satisfies ReadonlyArray<OrgTransferMovedTable>

function cell(row: OrgTransferRow, column: string) {
	const value = row[column]
	return value == null ? '' : String(value)
}

/**
 * Rewrites denormalized follow target columns after the source row has moved.
 * `follower_org_id` stays put. The EXISTS guard skips the rewrite when the
 * source row did not actually change owner in this batch.
 */
function retargetFollowSql(sourceTable: 'saved_packages' | 'user_repos') {
	switch (sourceTable) {
		case 'saved_packages':
			return `UPDATE follows
			 SET target_owner_id = ?, target_name = ?, updated_at = ?
			 WHERE target_kind = ? AND target_id = ? AND target_owner_id = ?
			 AND EXISTS (
			 	SELECT 1 FROM saved_packages
			 	WHERE id = ? AND user_id = ? AND rowid = ?
			 )`
		case 'user_repos':
			return `UPDATE follows
			 SET target_owner_id = ?, target_name = ?, updated_at = ?
			 WHERE target_kind = ? AND target_id = ? AND target_owner_id = ?
			 AND EXISTS (
			 	SELECT 1 FROM user_repos
			 	WHERE id = ? AND user_id = ? AND rowid = ?
			 )`
		default: {
			const exhaustive: never = sourceTable
			throw new Error(`Unsupported follow retarget table: ${exhaustive}`)
		}
	}
}

function retargetFollowStatement(
	db: D1Database,
	input: {
		toId: string
		fromId: string
		now: string
		targetKind: 'package' | 'repo'
		targetId: string
		targetName: string
		sourceTable: 'saved_packages' | 'user_repos'
		sourceRowid: number
	},
) {
	return db
		.prepare(retargetFollowSql(input.sourceTable))
		.bind(
			input.toId,
			input.targetName,
			input.now,
			input.targetKind,
			input.targetId,
			input.fromId,
			input.targetId,
			input.toId,
			input.sourceRowid,
		)
}

function chunks<T>(items: Array<T>, size: number) {
	const out: Array<Array<T>> = []
	for (let index = 0; index < items.length; index += size) {
		out.push(items.slice(index, index + size))
	}
	return out
}

function rowids(rows: Array<OrgTransferRow>) {
	return rows.map((row) => row.__rowid)
}

function ownerColumn(table: keyof typeof orgTransferOwnerTables) {
	return orgTransferOwnerTables[table]
}

export function buildOrgTransferStatements(input: {
	db: D1Database
	plan: OrgTransferPlan
	sealed: OrgTransferSealedColumns
	cleanupOrphans: boolean
	now: string
	auditStatements: Array<D1PreparedStatement>
}): Array<D1PreparedStatement> {
	const { db, plan, sealed, now } = input
	const fromId = plan.from.id
	const toId = plan.to.id
	const statements: Array<D1PreparedStatement> = [
		// user_integrations → user_oauth_apps is a composite foreign key; both
		// sides move in this batch.
		db.prepare('PRAGMA defer_foreign_keys = ON'),
	]
	const sealedFor = (table: string, row: OrgTransferRow) =>
		sealed.get(sealedRowKey(table, row.__rowid)) ?? {}

	for (const table of orgTransferRepointedTables) {
		const column = ownerColumn(table)
		for (const ids of chunks(rowids(plan.moves[table]), rowidChunkSize)) {
			statements.push(
				db
					.prepare(
						`UPDATE ${table} SET ${column} = ?
						 WHERE ${column} = ? AND rowid IN (SELECT value FROM json_each(?))`,
					)
					.bind(toId, fromId, JSON.stringify(ids)),
			)
		}
	}

	for (const row of plan.moves.saved_packages) {
		const packageId = cell(row, 'id')
		const packageName = transferredPackageName(row, plan.to.slug)
		statements.push(
			db
				.prepare(
					`UPDATE saved_packages
					 SET user_id = ?, name = ?, is_internet_visible = 0, updated_at = ?
					 WHERE rowid = ? AND user_id = ?`,
				)
				.bind(toId, packageName, now, row.__rowid, fromId),
		)
		statements.push(
			retargetFollowStatement(db, {
				toId,
				fromId,
				now,
				targetKind: 'package',
				targetId: packageId,
				targetName: packageName,
				sourceTable: 'saved_packages',
				sourceRowid: row.__rowid,
			}),
		)
	}
	for (const row of plan.moves.user_repos) {
		statements.push(
			retargetFollowStatement(db, {
				toId,
				fromId,
				now,
				targetKind: 'repo',
				targetId: cell(row, 'id'),
				targetName: `@${plan.to.slug}/${cell(row, 'name')}`,
				sourceTable: 'user_repos',
				sourceRowid: row.__rowid,
			}),
		)
	}
	for (const row of plan.moves.community_listings) {
		statements.push(
			db
				.prepare(
					`UPDATE community_listings SET owner_user_id = ?, name = ?, updated_at = ?
					 WHERE rowid = ? AND owner_user_id = ?`,
				)
				.bind(
					toId,
					transferredPackageName(row, plan.to.slug),
					now,
					row.__rowid,
					fromId,
				),
		)
	}

	const logoKeys = new Map(
		plan.logoCopies.map((copy) => [`${copy.table}:${copy.rowid}`, copy.toKey]),
	)
	for (const table of [
		'user_oauth_apps',
		'user_integrations',
		'webhook_endpoints',
	] as const) {
		for (const row of plan.moves[table]) {
			const assignments: Record<string, string> = { ...sealedFor(table, row) }
			const logoKey = logoKeys.get(`${table}:${row.__rowid}`)
			if (logoKey) assignments.logo_key = logoKey
			const columns = Object.keys(assignments)
			statements.push(
				db
					.prepare(
						`UPDATE ${table} SET user_id = ?${columns.map((column) => `, ${column} = ?`).join('')}
						 WHERE rowid = ? AND user_id = ?`,
					)
					.bind(
						toId,
						...columns.map((column) => assignments[column]),
						row.__rowid,
						fromId,
					),
			)
		}
	}
	for (const copy of plan.logoCopies) {
		if (copy.table !== 'mcp_server_settings') continue
		statements.push(
			db
				.prepare(
					`UPDATE mcp_server_settings SET logo_key = ?
					 WHERE rowid = ? AND user_id = ? AND logo_key = ?`,
				)
				.bind(copy.toKey, copy.rowid, toId, copy.fromKey),
		)
	}

	for (const [entryTable, bucketTable] of [
		['secret_entries', 'secret_buckets'],
	] as const) {
		const merges = plan.bucketMerges[bucketTable]
		for (const row of plan.moves[entryTable]) {
			const bucketId = String(row['bucket_id'])
			const assignments: Record<string, string> = {
				...sealedFor(entryTable, row),
			}
			const mergeInto = merges.get(bucketId)
			if (mergeInto) assignments.bucket_id = mergeInto
			const columns = Object.keys(assignments)
			if (columns.length === 0) continue
			statements.push(
				db
					.prepare(
						`UPDATE ${entryTable} SET ${columns.map((column) => `${column} = ?`).join(', ')}
						 WHERE rowid = ? AND bucket_id = ?`,
					)
					.bind(
						...columns.map((column) => assignments[column]),
						row.__rowid,
						bucketId,
					),
			)
		}
	}

	for (const table of [
		'saved_package_search_index_debt',
		'vector_embed_fingerprints',
	] as const) {
		for (const ids of chunks(
			rowids(plan.derivedDeletes[table]),
			rowidChunkSize,
		)) {
			statements.push(
				db
					.prepare(
						`DELETE FROM ${table}
						 WHERE user_id = ? AND rowid IN (SELECT value FROM json_each(?))`,
					)
					.bind(fromId, JSON.stringify(ids)),
			)
		}
	}

	if (input.cleanupOrphans) {
		statements.push(...buildOrphanCleanupStatements({ db, plan, now }))
	}

	statements.push(bumpAccessEpochStatement(db, fromId))
	statements.push(bumpAccessEpochStatement(db, toId))
	statements.push(...input.auditStatements)
	return statements
}

function buildOrphanCleanupStatements(input: {
	db: D1Database
	plan: OrgTransferPlan
	now: string
}) {
	const byTableAndCleanup = new Map<string, Array<OrgTransferOrphan>>()
	for (const orphan of input.plan.orphans) {
		switch (orphan.cleanup) {
			case 'soft-delete':
			case 'delete': {
				const key = `${orphan.cleanup}:${orphan.table}`
				byTableAndCleanup.set(key, [
					...(byTableAndCleanup.get(key) ?? []),
					orphan,
				])
				break
			}
			// Need side storage cleared, so post-commit owns them.
			case 'entity-source':
			case 'storage-bucket':
				break
			default: {
				const exhaustive: never = orphan.cleanup
				throw new Error(`Unknown orphan cleanup: ${String(exhaustive)}`)
			}
		}
	}
	const statements: Array<D1PreparedStatement> = []
	for (const [key, orphans] of byTableAndCleanup) {
		const [cleanup, table] = key.split(':') as [string, string]
		for (const ids of chunks(
			orphans.map((orphan) => orphan.row.__rowid),
			rowidChunkSize,
		)) {
			statements.push(
				cleanup === 'soft-delete'
					? input.db
							.prepare(
								`UPDATE ${table} SET deleted_at = ?
								 WHERE deleted_at IS NULL AND rowid IN (SELECT value FROM json_each(?))`,
							)
							.bind(input.now, JSON.stringify(ids))
					: input.db
							.prepare(
								`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`,
							)
							.bind(JSON.stringify(ids)),
			)
		}
	}
	return statements
}

/**
 * Rows the plan moved that the source owner still holds after commit:
 * written or re-keyed between planning and the batch.
 */
export async function countOrgTransferLeftovers(input: {
	db: D1Database
	plan: OrgTransferPlan
}) {
	const leftovers: Record<string, number> = {}
	for (const table of [
		...orgTransferRepointedTables,
		'saved_packages',
		'community_listings',
		'user_oauth_apps',
		'user_integrations',
		'webhook_endpoints',
	] as const) {
		const ids = rowids(input.plan.moves[table])
		if (ids.length === 0) continue
		const column = ownerColumn(table)
		let count = 0
		for (const chunk of chunks(ids, rowidChunkSize)) {
			const row = await input.db
				.prepare(
					`SELECT COUNT(*) AS count FROM ${table}
					 WHERE ${column} = ? AND rowid IN (SELECT value FROM json_each(?))`,
				)
				.bind(input.plan.from.id, JSON.stringify(chunk))
				.first<{ count: number }>()
			count += Number(row?.count ?? 0)
		}
		if (count > 0) leftovers[table] = count
	}
	return leftovers
}
