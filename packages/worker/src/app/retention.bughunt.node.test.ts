import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { pruneRetention } from './retention.ts'

test('bughunt: one failing table (AUDIT_DB) aborts retention for every later table', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const brokenAuditDb = {
		prepare: () => {
			throw new Error('D1_ERROR: audit db unavailable')
		},
	} as unknown as D1Database
	const kv = {
		delete: async () => {},
		list: async () => ({ keys: [], list_complete: true }),
	}
	let result: Awaited<ReturnType<typeof pruneRetention>> | undefined
	let error: unknown
	try {
		result = await pruneRetention({
			env: {
				APP_DB: db,
				AUDIT_DB: brokenAuditDb,
				BUNDLE_ARTIFACTS_KV: kv,
			} as never,
			now: new Date('2026-11-22T00:00:00.000Z'),
		})
	} catch (caught) {
		error = caught
	}
	expect(error).toBeUndefined()
	expect(result?.batchesPerTable.stripe_webhook_events).toBe(1)
	expect(result?.batchesPerTable.profiles).toBe(1)
})
