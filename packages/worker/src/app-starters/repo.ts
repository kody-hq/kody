export type AppStarterRow = {
	packageId: string
	rank: number
	enabled: boolean
	note: string | null
}

function mapAppStarterRow(row: Record<string, unknown>): AppStarterRow {
	return {
		packageId: String(row['package_id']),
		rank: Number(row['rank']),
		enabled: Number(row['enabled']) === 1,
		note: row['note'] == null ? null : String(row['note']),
	}
}

export async function listAppStarterRows(
	db: D1Database,
	input: { enabledOnly?: boolean } = {},
): Promise<Array<AppStarterRow>> {
	const rows = await db
		.prepare(
			`SELECT package_id, rank, enabled, note
			FROM app_starters${input.enabledOnly ? ' WHERE enabled = 1' : ''}
			ORDER BY rank ASC, package_id ASC`,
		)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapAppStarterRow)
}

export async function insertAppStarterRow(db: D1Database, row: AppStarterRow) {
	await db
		.prepare(
			`INSERT INTO app_starters (package_id, rank, enabled, note)
			VALUES (?, ?, ?, ?)`,
		)
		.bind(row.packageId, row.rank, row.enabled ? 1 : 0, row.note)
		.run()
}

/** Writes every row's rank, enabled flag, and note in one batch. */
export async function saveAppStarterRows(
	db: D1Database,
	rows: Array<AppStarterRow>,
) {
	if (rows.length === 0) return
	await db.batch(
		rows.map((row) =>
			db
				.prepare(
					`UPDATE app_starters SET rank = ?, enabled = ?, note = ?
					WHERE package_id = ?`,
				)
				.bind(row.rank, row.enabled ? 1 : 0, row.note, row.packageId),
		),
	)
}

export async function deleteAppStarterRow(db: D1Database, packageId: string) {
	await db
		.prepare(`DELETE FROM app_starters WHERE package_id = ?`)
		.bind(packageId)
		.run()
}
