import {
	backfillStoredBundleArtifactManifest,
	type StoredBundleArtifactManifestBackfill,
} from './published-runtime-artifacts.ts'

export const bundleArtifactManifestBackfillLimitDefault = 25
export const bundleArtifactManifestBackfillLimitMax = 100

type BackfillRow = {
	id: string
	user_id: string
	source_id: string
	published_commit: string
	kv_key: string
}

export type BundleArtifactManifestBackfillOutcome = {
	rowId: string
	userId: string
	sourceId: string
	publishedCommit: string
	kvKey: string
	status: StoredBundleArtifactManifestBackfill['status'] | 'row_changed'
	totalBytes: number | null
}

export type BundleArtifactManifestBackfillResult = {
	dryRun: boolean
	scannedRows: number
	/** Rows whose `total_bytes` was set (apply) or would be (dry run). */
	filledRows: number
	/** Stored artifacts that gained a manifest (apply) or would (dry run). */
	manifestsWritten: number
	/** Rows whose stored artifact is missing or unusable; left untouched. */
	unbackfillableRows: number
	/** Rows whose stored artifact could not be read this time; run again. */
	readFailedRows: number
	nextCursor: string | null
	/** Only the rows that could not be filled. */
	problems: Array<BundleArtifactManifestBackfillOutcome>
}

/**
 * One page of the manifest backfill (#5178): for each identity row without
 * `total_bytes`, add a manifest to its stored artifact when it has none and
 * record the total on the row. No module bytes change and nothing is rebuilt.
 */
export async function runBundleArtifactManifestBackfill(input: {
	env: Env
	dryRun: boolean
	afterId: string | null
	limit?: number
	userIds?: ReadonlyArray<string>
	sourceIds?: ReadonlyArray<string>
}): Promise<BundleArtifactManifestBackfillResult> {
	const limit = Math.min(
		input.limit ?? bundleArtifactManifestBackfillLimitDefault,
		bundleArtifactManifestBackfillLimitMax,
	)
	const filters: Array<string> = []
	const binds: Array<string | number> = [input.afterId ?? '']
	for (const [column, values] of [
		['user_id', input.userIds],
		['source_id', input.sourceIds],
	] as const) {
		if (!values?.length) continue
		filters.push(`AND ${column} IN (${values.map(() => '?').join(', ')})`)
		binds.push(...values)
	}
	const db = input.env.APP_DB
	const { results: rows } = await db
		.prepare(
			`SELECT id, user_id, source_id, published_commit, kv_key
			FROM published_bundle_artifacts
			WHERE total_bytes IS NULL AND id > ? ${filters.join(' ')}
			ORDER BY id
			LIMIT ?`,
		)
		.bind(...binds, limit)
		.all<BackfillRow>()

	const result: BundleArtifactManifestBackfillResult = {
		dryRun: input.dryRun,
		scannedRows: rows.length,
		filledRows: 0,
		manifestsWritten: 0,
		unbackfillableRows: 0,
		readFailedRows: 0,
		nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
		problems: [],
	}
	for (const row of rows) {
		const stored = await backfillStoredBundleArtifactManifest({
			env: input.env,
			kvKey: row.kv_key,
			dryRun: input.dryRun,
		})
		let status: BundleArtifactManifestBackfillOutcome['status'] = stored.status
		const totalBytes = 'totalBytes' in stored ? stored.totalBytes : null
		if (stored.status === 'read_failed') {
			result.readFailedRows += 1
		} else if (totalBytes === null) {
			result.unbackfillableRows += 1
		} else {
			if (stored.status !== 'already') result.manifestsWritten += 1
			if (input.dryRun) {
				result.filledRows += 1
				continue
			}
			// A publish that moved the row meanwhile records its own total.
			const update = await db
				.prepare(
					`UPDATE published_bundle_artifacts
					SET total_bytes = ?
					WHERE id = ? AND kv_key = ? AND total_bytes IS NULL`,
				)
				.bind(totalBytes, row.id, row.kv_key)
				.run()
			if (update.meta.changes > 0) {
				result.filledRows += 1
				continue
			}
			status = 'row_changed'
		}
		result.problems.push({
			rowId: row.id,
			userId: row.user_id,
			sourceId: row.source_id,
			publishedCommit: row.published_commit,
			kvKey: row.kv_key,
			status,
			totalBytes,
		})
	}
	return result
}
