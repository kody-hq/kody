import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createGuestAccount,
	guestFullAccessMs,
	guestHoldMs,
} from './guest-accounts.ts'

const deleteUserAccount = vi.hoisted(() => vi.fn(async () => {}))
vi.unmock('#worker/audit-log.ts')
vi.mock('#app/account-deletion.ts', () => ({ deleteUserAccount }))
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent: vi.fn(),
}))

const start = new Date('2026-11-04T07:00:00.000Z')

function slowAuditDb() {
	const writes: Array<unknown> = []
	const db = {
		prepare: () => ({
			bind: (...values: Array<unknown>) => ({
				run: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20))
					writes.push(values)
					return { success: true, meta: {} }
				},
			}),
		}),
	} as unknown as D1Database
	return { db, writes }
}

test('the guest purge lane finishes the guest_account_purged audit write before it resolves', async () => {
	const { pruneExpiredGuestAccounts } = await import('./guest-account-purge.ts')
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const appDb = createD1FromSqlite(sqlite)
	const guest = await createGuestAccount({
		env: {
			APP_DB: appDb,
			SECRET_STORE_KEY: 'guest-test-secret-store-key-32-characters-ok',
		},
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: start,
	})
	if (!guest.ok) throw new Error('guest was not created')
	const audit = slowAuditDb()
	const result = await pruneExpiredGuestAccounts({
		env: { APP_DB: appDb, AUDIT_DB: audit.db } as unknown as Env,
		now: new Date(start.getTime() + guestFullAccessMs + guestHoldMs),
	})
	expect(result.purged).toBe(1)
	expect(audit.writes).toHaveLength(1)
})
