import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { upsertSavedPackageVector } from './vectorize.ts'

/**
 * Deferred saved-package vector upserts must not fail silently. Before
 * scheduling work on `waitUntil`, mark debt; clear it on success; keep it
 * (with the error) on failure and report to Sentry. Capability reindex also
 * clears debt after a successful upsert so search converges even if the
 * original waitUntil never ran. A full capability reindex that includes the
 * packages phase also clears matching debt after a successful upsert.
 *
 * Each schedule bumps a per-package `generation` and stores the latest
 * `embed_text`. An in-flight reconcile (coalesced per isolate) re-reads the
 * debt row after every upsert so a newer publish wins; stale completions
 * cannot clear newer debt.
 */

type SearchIndexDebtRow = {
	packageId: string
	userId: OwnerId
	generation: number
	embedText: string
}

/** Coalesce concurrent schedules for the same package in one isolate. */
const inFlightReconciles = new Map<string, Promise<void>>()

export async function markSavedPackageSearchIndexDebt(input: {
	db: D1Database
	packageId: string
	userId: OwnerId
	embedText: string
	lastError?: string | null
}): Promise<number> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO saved_package_search_index_debt (
				package_id, user_id, generation, embed_text, last_error, created_at, updated_at
			) VALUES (?, ?, 1, ?, ?, ?, ?)
			ON CONFLICT(package_id) DO UPDATE SET
				user_id = excluded.user_id,
				generation = saved_package_search_index_debt.generation + 1,
				embed_text = excluded.embed_text,
				last_error = excluded.last_error,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.packageId,
			input.userId,
			input.embedText,
			input.lastError ?? null,
			now,
			now,
		)
		.run()
	const row = await input.db
		.prepare(
			`SELECT generation FROM saved_package_search_index_debt WHERE package_id = ?`,
		)
		.bind(input.packageId)
		.first<{ generation: number }>()
	return row?.generation ?? 1
}

export async function clearSavedPackageSearchIndexDebt(input: {
	db: D1Database
	packageId: string
	generation: number
}) {
	await input.db
		.prepare(
			`DELETE FROM saved_package_search_index_debt
			WHERE package_id = ? AND generation = ?`,
		)
		.bind(input.packageId, input.generation)
		.run()
}

/** Read current debt generation, or null when no debt row exists. */
export async function getSavedPackageSearchIndexDebtGeneration(input: {
	db: D1Database
	packageId: string
}): Promise<number | null> {
	const row = await input.db
		.prepare(
			`SELECT generation FROM saved_package_search_index_debt WHERE package_id = ?`,
		)
		.bind(input.packageId)
		.first<{ generation: number }>()
	return row?.generation ?? null
}

async function readSavedPackageSearchIndexDebt(input: {
	db: D1Database
	packageId: string
}): Promise<SearchIndexDebtRow | null> {
	const row = await input.db
		.prepare(
			`SELECT package_id, user_id, generation, embed_text
			FROM saved_package_search_index_debt
			WHERE package_id = ?`,
		)
		.bind(input.packageId)
		.first<{
			package_id: string
			user_id: OwnerId
			generation: number
			embed_text: string
		}>()
	if (!row) return null
	return {
		packageId: row.package_id,
		userId: row.user_id,
		generation: row.generation,
		embedText: row.embed_text,
	}
}

async function recordSavedPackageSearchIndexDebtFailure(input: {
	db: D1Database
	packageId: string
	generation: number
	lastError: string
}) {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`UPDATE saved_package_search_index_debt
			SET last_error = ?, updated_at = ?
			WHERE package_id = ? AND generation = ?`,
		)
		.bind(input.lastError, now, input.packageId, input.generation)
		.run()
}

export async function listSavedPackageSearchIndexDebt(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ packageId: string; userId: OwnerId }>> {
	const rows = await input.db
		.prepare(
			`SELECT package_id, user_id
			FROM saved_package_search_index_debt
			ORDER BY updated_at ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<{ package_id: string; user_id: OwnerId }>()
	return (rows.results ?? []).map((row) => ({
		packageId: row.package_id,
		userId: row.user_id,
	}))
}

function logSavedPackageSearchIndexError(input: {
	packageId: string
	userId: string
	error: unknown
}) {
	console.error(
		JSON.stringify({
			message: 'saved package search index upsert failed',
			packageId: input.packageId,
			userId: input.userId,
			error: getErrorMessage(input.error),
		}),
	)
	Sentry.captureException(input.error, {
		tags: {
			scope: 'saved-package-search-index',
			action: 'upsert',
		},
		extra: {
			packageId: input.packageId,
			userId: input.userId,
		},
	})
}

async function reconcileSavedPackageSearchIndex(input: {
	env: Env
	packageId: string
}) {
	let failureGeneration: number | null = null
	let failureUserId: string | null = null
	try {
		for (;;) {
			const row = await readSavedPackageSearchIndexDebt({
				db: input.env.APP_DB,
				packageId: input.packageId,
			})
			if (!row) return
			failureGeneration = row.generation
			failureUserId = row.userId
			// Always upsert under the debt row owner — never the scheduling
			// caller's userId — so a coalesced reconcile cannot write one
			// user's embed text into another namespace if ownership changed.
			await upsertSavedPackageVector(input.env, {
				packageId: input.packageId,
				userId: row.userId,
				embedText: row.embedText,
			})
			const latest = await readSavedPackageSearchIndexDebt({
				db: input.env.APP_DB,
				packageId: input.packageId,
			})
			if (!latest) return
			if (latest.generation !== row.generation) {
				// A newer publish queued fresher embed text; loop.
				continue
			}
			await clearSavedPackageSearchIndexDebt({
				db: input.env.APP_DB,
				packageId: input.packageId,
				generation: row.generation,
			})
			const remaining = await readSavedPackageSearchIndexDebt({
				db: input.env.APP_DB,
				packageId: input.packageId,
			})
			if (!remaining) return
		}
	} catch (error: unknown) {
		try {
			if (failureGeneration !== null) {
				await recordSavedPackageSearchIndexDebtFailure({
					db: input.env.APP_DB,
					packageId: input.packageId,
					generation: failureGeneration,
					lastError: getErrorMessage(error),
				})
			}
		} catch (debtError) {
			console.error(
				JSON.stringify({
					message: 'failed to persist search index debt after upsert failure',
					packageId: input.packageId,
					error: getErrorMessage(debtError),
				}),
			)
		}
		logSavedPackageSearchIndexError({
			packageId: input.packageId,
			userId: failureUserId ?? 'unknown',
			error,
		})
	}
}

/**
 * Upsert the package vector after the response when `waitUntil` is available;
 * otherwise await (same observability either way). Debt is marked before the
 * work starts so a dropped waitUntil still leaves a reconcile target.
 */
export async function scheduleSavedPackageSearchIndexUpsert(input: {
	env: Env
	packageId: string
	userId: OwnerId
	embedText: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	await markSavedPackageSearchIndexDebt({
		db: input.env.APP_DB,
		packageId: input.packageId,
		userId: input.userId,
		embedText: input.embedText,
	})

	const existing = inFlightReconciles.get(input.packageId)
	if (existing) {
		if (input.waitUntil) {
			input.waitUntil(existing)
			return
		}
		await existing
		return
	}

	const task = reconcileSavedPackageSearchIndex({
		env: input.env,
		packageId: input.packageId,
	}).finally(() => {
		inFlightReconciles.delete(input.packageId)
	})
	inFlightReconciles.set(input.packageId, task)

	if (input.waitUntil) {
		input.waitUntil(task)
		return
	}
	await task
}
