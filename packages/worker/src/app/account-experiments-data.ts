import { listSelfServeExperimentsForUser } from '#worker/feature-flags/self-serve-experiments.ts'
import { type AccountExperimentsLoaderData } from '#universal/loader-data.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export async function readExperimentsOptIn(
	db: D1Database,
	userId: number,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT experiments_opt_in FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{ experiments_opt_in: number }>()
	return row?.experiments_opt_in === 1
}

export async function setExperimentsOptIn(
	db: D1Database,
	input: { userId: number; enabled: boolean },
): Promise<void> {
	await db
		.prepare(
			`UPDATE users
			 SET experiments_opt_in = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.enabled ? 1 : 0, input.userId)
		.run()
}

export async function loadAccountExperimentsData(input: {
	db: D1Database
	userId: number
}): Promise<AccountExperimentsLoaderData> {
	const [experimentsOptIn, experiments] = await Promise.all([
		readExperimentsOptIn(input.db, input.userId),
		listSelfServeExperimentsForUser(input.db, input.userId),
	])
	return { ok: true, experimentsOptIn, experiments }
}
