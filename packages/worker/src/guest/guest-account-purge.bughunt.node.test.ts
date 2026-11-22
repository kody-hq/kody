import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createGuestAccount,
	guestFullAccessMs,
	guestHoldMs,
	readGuestAccountByPerson,
} from './guest-accounts.ts'

const deleteUserAccount = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('#app/account-deletion.ts', () => ({ deleteUserAccount }))
const scheduleUserDeletedEvent = vi.hoisted(() => vi.fn())
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent,
}))

const start = new Date('2026-11-04T07:00:00.000Z')
const secretStoreKey = 'guest-test-secret-store-key-32-characters-ok'
const afterHold = new Date(start.getTime() + guestFullAccessMs + guestHoldMs)

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

async function createGuest(db: D1Database) {
	const result = await createGuestAccount({
		env: { APP_DB: db, SECRET_STORE_KEY: secretStoreKey },
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: start,
	})
	if (!result.ok) throw new Error('guest was not created')
	return result
}

function deleteUsersRow(db: D1Database, personId: string) {
	deleteUserAccount.mockImplementationOnce(async () => {
		await db
			.prepare(`DELETE FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.run()
	})
}

test('bughunt: a transient guest-row delete failure loses the user-deleted event and purge audit for good', async () => {
	const { pruneExpiredGuestAccounts } = await import('./guest-account-purge.ts')
	const db = createDb()
	const guest = await createGuest(db)
	deleteUsersRow(db, guest.personId)
	let failGuestRowDelete = true
	const flakyDb = new Proxy(db, {
		get(target, property, receiver) {
			if (property !== 'prepare') return Reflect.get(target, property, receiver)
			return (sql: string) => {
				if (
					failGuestRowDelete &&
					sql.startsWith('DELETE FROM guest_accounts')
				) {
					failGuestRowDelete = false
					return {
						bind: () => ({
							run: async () => {
								throw new Error('D1_ERROR: network connection lost')
							},
						}),
					}
				}
				return target.prepare(sql)
			}
		},
	})
	consoleError.mockImplementation(() => {})
	await pruneExpiredGuestAccounts({
		env: { APP_DB: flakyDb, SENTRY_ENVIRONMENT: 'test' } as unknown as Env,
		now: afterHold,
	})
	await pruneExpiredGuestAccounts({
		env: { APP_DB: db, SENTRY_ENVIRONMENT: 'test' } as unknown as Env,
		now: afterHold,
	})
	expect(await readGuestAccountByPerson(db, guest.personId)).toBeNull()
	expect(deleteUserAccount).toHaveBeenCalledTimes(1)
	// The person is gone, so some run must announce the deletion.
	expect(scheduleUserDeletedEvent).toHaveBeenCalledTimes(1)
})

test('bughunt: guest_account_purged audit write is not awaited before the purge returns', async () => {
	const { pruneExpiredGuestAccounts } = await import('./guest-account-purge.ts')
	const db = createDb()
	const guest = await createGuest(db)
	deleteUsersRow(db, guest.personId)
	let auditWriteFinished = false
	const auditDb = {
		prepare: () => ({
			bind: () => ({
				run: () =>
					new Promise((resolve) =>
						setTimeout(() => {
							auditWriteFinished = true
							resolve({ success: true, meta: { changes: 1 } })
						}, 25),
					),
			}),
		}),
	} as unknown as D1Database
	const result = await pruneExpiredGuestAccounts({
		env: { APP_DB: db, AUDIT_DB: auditDb } as unknown as Env,
		now: afterHold,
	})
	expect(result.purged).toBe(1)
	expect(auditWriteFinished).toBe(true)
})
