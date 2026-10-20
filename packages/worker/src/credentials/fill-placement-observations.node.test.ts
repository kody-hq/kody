import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	readFillPlacementObservation,
	recordFillPlacementObservation,
} from './fill-placement-observations.ts'

vi.mock('cloudflare:workers', () => ({
	waitUntil: (promise: Promise<unknown>) => {
		void promise
	},
}))

test('recordFillPlacementObservation merges filled and would-block last-seen', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	await recordFillPlacementObservation({
		db,
		credentialId: 'cred-1',
		filledParts: ['headers'],
		wouldBlockParts: ['body'],
		at: '2026-10-20T12:00:00.000Z',
	})
	await recordFillPlacementObservation({
		db,
		credentialId: 'cred-1',
		filledParts: ['query'],
		wouldBlockParts: ['path'],
		at: '2026-10-20T13:00:00.000Z',
	})

	await expect(readFillPlacementObservation(db, 'cred-1')).resolves.toEqual({
		filledLastSeen: {
			headers: '2026-10-20T12:00:00.000Z',
			query: '2026-10-20T13:00:00.000Z',
		},
		wouldBlockLastSeen: {
			body: '2026-10-20T12:00:00.000Z',
			path: '2026-10-20T13:00:00.000Z',
		},
		updatedAt: '2026-10-20T13:00:00.000Z',
	})
})

test('recordFillPlacementObservation json_patch keeps sibling parts across writes', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	await Promise.all([
		recordFillPlacementObservation({
			db,
			credentialId: 'cred-race',
			filledParts: ['headers'],
			at: '2026-10-20T12:00:00.000Z',
		}),
		recordFillPlacementObservation({
			db,
			credentialId: 'cred-race',
			wouldBlockParts: ['body'],
			at: '2026-10-20T12:00:01.000Z',
		}),
	])

	const view = await readFillPlacementObservation(db, 'cred-race')
	expect(view?.filledLastSeen.headers).toBe('2026-10-20T12:00:00.000Z')
	expect(view?.wouldBlockLastSeen.body).toBe('2026-10-20T12:00:01.000Z')
})
