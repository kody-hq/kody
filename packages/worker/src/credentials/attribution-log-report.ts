/**
 * Read-only counts from the credential attribution log. Ids, kinds and
 * counts only: never credential names or values. Writes nothing.
 */
export const attributionLogReportDaysMax = 31
const attributionLogReportRowsMax = 200

export type AttributionLogReport = {
	sinceDay: string
	totals: Array<{
		kind: string
		surface: string
		pattern: string
		rows: number
		observations: number
		owners: number
		credentials: number
	}>
	/** Largest groups first, capped. */
	packages: Array<{
		kind: string
		surface: string
		pattern: string
		runPackageId: string
		boundPackageId: string
		changedIntrinsics: string
		observations: number
		owners: number
		credentials: number
		firstSeenAt: string
		lastSeenAt: string
	}>
	packagesTruncated: boolean
}

export async function readAttributionLogReport(input: {
	db: D1Database
	days: number
	packageIds?: ReadonlyArray<string>
	now?: Date
}): Promise<AttributionLogReport> {
	const days = Math.max(1, Math.min(input.days, attributionLogReportDaysMax))
	const sinceDay = new Date(
		(input.now ?? new Date()).getTime() - (days - 1) * 86_400_000,
	)
		.toISOString()
		.slice(0, 10)
	const ids = [...new Set(input.packageIds ?? [])]
	const marks = ids.map(() => '?').join(', ')
	const filter = ids.length
		? ` AND (run_package_id IN (${marks}) OR bound_package_id IN (${marks}))`
		: ''
	const binds = [sinceDay, ...ids, ...ids]
	const totals = await input.db
		.prepare(
			`SELECT kind, surface, pattern, COUNT(*) AS row_count,
				SUM(observations) AS observations,
				COUNT(DISTINCT owner_id) AS owners,
				COUNT(DISTINCT credential_id) AS credentials
			 FROM credential_attribution_log
			 WHERE day >= ?${filter}
			 GROUP BY kind, surface, pattern
			 ORDER BY kind, surface, pattern`,
		)
		.bind(...binds)
		.all<Record<string, string | number>>()
	const packages = await input.db
		.prepare(
			`SELECT kind, surface, pattern, run_package_id, bound_package_id,
				changed_intrinsics, SUM(observations) AS observations,
				COUNT(DISTINCT owner_id) AS owners,
				COUNT(DISTINCT credential_id) AS credentials,
				MIN(first_seen_at) AS first_seen_at,
				MAX(last_seen_at) AS last_seen_at
			 FROM credential_attribution_log
			 WHERE day >= ?${filter}
			 GROUP BY kind, surface, pattern, run_package_id, bound_package_id, changed_intrinsics
			 ORDER BY observations DESC, kind, run_package_id, bound_package_id
			 LIMIT ?`,
		)
		.bind(...binds, attributionLogReportRowsMax + 1)
		.all<Record<string, string | number>>()
	const packageRows = packages.results ?? []
	return {
		sinceDay,
		totals: (totals.results ?? []).map((row) => ({
			kind: String(row.kind),
			surface: String(row.surface),
			pattern: String(row.pattern),
			rows: Number(row.row_count),
			observations: Number(row.observations),
			owners: Number(row.owners),
			credentials: Number(row.credentials),
		})),
		packages: packageRows.slice(0, attributionLogReportRowsMax).map((row) => ({
			kind: String(row.kind),
			surface: String(row.surface),
			pattern: String(row.pattern),
			runPackageId: String(row.run_package_id),
			boundPackageId: String(row.bound_package_id),
			changedIntrinsics: String(row.changed_intrinsics),
			observations: Number(row.observations),
			owners: Number(row.owners),
			credentials: Number(row.credentials),
			firstSeenAt: String(row.first_seen_at),
			lastSeenAt: String(row.last_seen_at),
		})),
		packagesTruncated: packageRows.length > attributionLogReportRowsMax,
	}
}
