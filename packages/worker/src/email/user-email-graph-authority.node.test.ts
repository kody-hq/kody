import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	assertUserEmailGraphAuthority,
	loadUserEmailGraphAuthorityMarker,
} from './user-email-graph-authority.ts'

function dbWithMarker(
	row: {
		owner_count: number
		frozen_at: string
		dropped_at?: string | null
	} | null,
) {
	return {
		prepare(sql: string) {
			return {
				async first() {
					expect(sql).toContain('SELECT *')
					return row
				},
			}
		},
	} as unknown as D1Database
}

test('USER writes require the authority marker while system writes are unaffected', async () => {
	await expect(
		assertUserEmailGraphAuthority({
			db: dbWithMarker(null),
			ownerId: ownerIdFromStored('user-1'),
		}),
	).rejects.toThrow(/cutover marker is missing/)
	await expect(
		assertUserEmailGraphAuthority({
			db: dbWithMarker(null),
			ownerId: ownerIdFromStored('system:email'),
		}),
	).resolves.toBeUndefined()
	const db = dbWithMarker({
		owner_count: 12,
		frozen_at: '2026-08-03T00:00:00.000Z',
		dropped_at: '2026-08-03T15:00:00.000Z',
	})
	await expect(
		assertUserEmailGraphAuthority({ db, ownerId: ownerIdFromStored('user-1') }),
	).resolves.toBeUndefined()
	await expect(loadUserEmailGraphAuthorityMarker(db)).resolves.toEqual({
		ownerCount: 12,
		frozenAt: '2026-08-03T00:00:00.000Z',
		droppedAt: '2026-08-03T15:00:00.000Z',
	})
})
