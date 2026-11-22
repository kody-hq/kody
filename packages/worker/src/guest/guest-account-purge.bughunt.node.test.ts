import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	createGuestAccount,
	guestFullAccessMs,
	guestHoldMs,
} from './guest-accounts.ts'

const deleteUserAccount = vi.hoisted(() =>
	vi.fn(async (_input: { env: Env; dbUserId: number }) => {}),
)
vi.mock('#app/account-deletion.ts', async (importOriginal) => {
	const { promiseDouble } =
		await import('#worker/test-support/effect-bridge.ts')
	return {
		...(await importOriginal<object>()),
		deleteUserAccount,
		deleteUserAccountEffect: promiseDouble(deleteUserAccount),
	}
})
const scheduleUserDeletedEvent = vi.hoisted(() => vi.fn())
vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserDeletedEvent,
}))

const { pruneExpiredGuestAccounts } = await import('./guest-account-purge.ts')
const { AccountDeletionCleanupError } = await import('#app/account-deletion.ts')

const start = new Date('2026-11-04T07:00:00.000Z')
const afterHold = new Date(start.getTime() + guestFullAccessMs + guestHoldMs)
const secretStoreKey = 'guest-test-secret-store-key-32-characters-ok'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function createGuest(db: D1Database) {
	const result = await createGuestAccount({
		env: { APP_DB: db, SECRET_STORE_KEY: secretStoreKey } as unknown as Env,
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: start,
	})
	if (!result.ok) throw new Error('guest was not created')
	return result
}

test('bughunt v6a: a guest whose account deletion failed after fencing is retried by the guest lane', async () => {
	const { sqlite, db } = createDb()
	const guest = await createGuest(db)
	silenceExpectedConsoleErrors(['guest_account_purge_failed'])
	// Real deleteUserAccountEffect sets the live deletion fence (deleting_at)
	// and keeps it on a cleanup failure so a retry can finish.
	deleteUserAccount.mockImplementationOnce(async (input) => {
		await input.env.APP_DB.prepare(
			`UPDATE users SET deleting_at = ? WHERE id = ?`,
		)
			.bind('2026-11-11 07:00:00', input.dbUserId)
			.run()
		throw new AccountDeletionCleanupError({
			message: 'Account deletion cleanup failed',
			cleanupErrors: ['Artifact repo delete failed'],
		} as never)
	})
	const first = await pruneExpiredGuestAccounts({
		env: { APP_DB: db } as unknown as Env,
		now: afterHold,
	})
	expect(first.failed).toBe(1)
	// A day later the outage is over: the guest lane should retry the guest.
	const second = await pruneExpiredGuestAccounts({
		env: { APP_DB: db } as unknown as Env,
		now: new Date(afterHold.getTime() + 24 * 60 * 60 * 1000),
	})
	expect(second.scanned).toBe(1)
	expect(second.purged).toBe(1)
	expect(
		sqlite
			.prepare('SELECT COUNT(*) AS n FROM guest_accounts WHERE person_id = ?')
			.get(guest.personId),
	).toEqual({ n: 0 })
})

test('bughunt v6a: a guest_accounts delete failure after the account is deleted is not left orphaned', async () => {
	const { sqlite, db } = createDb()
	const guest = await createGuest(db)
	silenceExpectedConsoleErrors(['guest_account_purge_failed'])
	deleteUserAccount.mockImplementationOnce(async (input) => {
		await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
			.bind(input.dbUserId)
			.run()
	})
	let failGuestDelete = true
	const flaky = {
		prepare(query: string) {
			if (failGuestDelete && query.includes('DELETE FROM guest_accounts')) {
				failGuestDelete = false
				return {
					bind: () => ({
						run: async () => {
							throw new Error('D1_ERROR: Network connection lost.')
						},
					}),
				}
			}
			return db.prepare(query)
		},
		batch: db.batch.bind(db),
	} as unknown as D1Database
	const first = await pruneExpiredGuestAccounts({
		env: { APP_DB: flaky } as unknown as Env,
		now: afterHold,
	})
	expect(first.failed).toBe(1)
	await pruneExpiredGuestAccounts({
		env: { APP_DB: db } as unknown as Env,
		now: new Date(afterHold.getTime() + 60 * 60 * 1000),
	})
	// The account is gone; its guest row (claim hash and sealed claim code)
	// and the user-deleted lifecycle event should not be lost.
	expect(scheduleUserDeletedEvent).toHaveBeenCalledOnce()
	expect(
		sqlite
			.prepare('SELECT COUNT(*) AS n FROM guest_accounts WHERE person_id = ?')
			.get(guest.personId),
	).toEqual({ n: 0 })
})
