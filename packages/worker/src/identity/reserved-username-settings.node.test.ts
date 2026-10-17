import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	addReservedUsernames,
	findReservedUsernameConflicts,
	getEffectiveReservedUsernameError,
	isEffectivelyReservedUsername,
	loadReservedUsernameRecord,
	loadReservedUsernameAdminSnapshot,
	PermanentlyReservedUsernameError,
	removeReservedUsernames,
	reservedUsernamesKvKey,
	reservedUsernamesKvReadFailedLogKey,
} from './reserved-username-settings.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from './username.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
		store,
	} as unknown as KVNamespace & { store: Map<string, string> }
}

function createEnv(kv?: KVNamespace) {
	return {
		BUNDLE_ARTIFACTS_KV: kv,
		APP_DB: {} as D1Database,
	} as unknown as Env
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function overrideEnv(added: Array<string>, removed: Array<string> = []) {
	const kv = createMemoryKv({
		[reservedUsernamesKvKey]: JSON.stringify({
			added,
			removed,
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	return { kv, env: createEnv(kv) }
}

async function mismatches<T>(
	cases: Array<{ username: string; expected: T }>,
	check: (username: string) => Promise<T>,
) {
	const actual = await Promise.all(cases.map(({ username }) => check(username)))
	return cases
		.map((entry, index) => ({ ...entry, actual: actual[index] }))
		.filter((entry) => entry.actual !== entry.expected)
}

async function insertUser(sqlite: DatabaseSync, username: string) {
	const email = `${username}-holder@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			${quoteSqlString(username)},
			${quoteSqlString(email)},
			${quoteSqlString(stableUserId)},
			'oauth_created_no_usable_password'
		);
	`)
	return stableUserId
}

test('reserved username KV overrides, fallback, memo, permanent lock, and conflicts', async () => {
	expect(await isEffectivelyReservedUsername('faq')).toBe(true)
	expect(await isEffectivelyReservedUsername('alice')).toBe(false)

	const { env: envWithOverride } = overrideEnv(['brandnew'], ['faq'])
	const overrideCases = [
		{ username: 'brandnew', expected: true },
		{ username: 'super-brandnew', expected: true },
		{ username: 'faq', expected: false },
		{ username: 'super-faq', expected: false },
		{ username: 'kody', expected: true },
	]
	expect(
		await mismatches(overrideCases, (username) =>
			isEffectivelyReservedUsername(username, envWithOverride),
		),
	).toEqual([])
	const errorCases = [
		{ username: 'brandnew', expected: true },
		{ username: 'faq', expected: false },
	]
	expect(
		await mismatches(
			errorCases,
			async (username) =>
				(await getEffectiveReservedUsernameError(username, envWithOverride)) !==
				null,
		),
	).toEqual([])
	expect(
		await mismatches(
			errorCases,
			async (username) =>
				(await getEffectiveUsernameValidationError(
					username,
					envWithOverride,
				)) !== null,
		),
	).toEqual([])

	const { env: swearEnv } = overrideEnv(['fuck'])
	const reservedMessage = 'This username is reserved.'
	const swearValidationCases = [
		{ username: 'fuckyou', expected: reservedMessage },
		{ username: 'FuckYou', expected: reservedMessage },
		{ username: normalizeUsername('FuckYou'), expected: reservedMessage },
		{ username: normalizeUsername('SUPERFUCK'), expected: reservedMessage },
		{ username: 'fuck_you', expected: reservedMessage },
		{ username: 'super-fuck', expected: reservedMessage },
		{ username: 'fu-ck', expected: reservedMessage },
	]
	expect(
		await mismatches(swearValidationCases, (username) =>
			getEffectiveUsernameValidationError(username, swearEnv),
		),
	).toEqual([])
	expect(await isEffectivelyReservedUsername('fuck_you', swearEnv)).toBe(true)
	expect(await isEffectivelyReservedUsername('super_fuck', swearEnv)).toBe(true)

	consoleWarn.mockImplementation(() => {})
	expect(
		await isEffectivelyReservedUsername(
			'faq',
			createEnv(createMemoryKv({ [reservedUsernamesKvKey]: '{not-json' })),
		),
	).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		reservedUsernamesKvReadFailedLogKey,
		expect.anything(),
	)

	vi.useFakeTimers()
	try {
		const { kv: memoKv, env: memoEnv } = overrideEnv(['brandnew'])
		const getSpy = vi.spyOn(memoKv, 'get')
		expect(await isEffectivelyReservedUsername('brandnew', memoEnv)).toBe(true)
		expect(await isEffectivelyReservedUsername('brandnew', memoEnv)).toBe(true)
		expect(getSpy).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(await isEffectivelyReservedUsername('brandnew', memoEnv)).toBe(true)
		expect(getSpy).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const setEnv = createEnv(createMemoryKv())
	const edit = (
		change: typeof addReservedUsernames,
		usernames: Array<string>,
	) => change({ env: setEnv, usernames, updatedBy: 'admin-stable-id' })
	const added = await edit(addReservedUsernames, [' BrandNew ', 'faq'])
	expect(added.added).toEqual(['brandnew'])
	expect(added.removed).toEqual([])
	expect(await isEffectivelyReservedUsername('brandnew', setEnv)).toBe(true)
	expect((await edit(addReservedUsernames, ['faq'])).removed).toEqual([])

	await edit(removeReservedUsernames, ['faq'])
	expect((await loadReservedUsernameRecord(setEnv)).removed).toEqual(['faq'])
	expect(await isEffectivelyReservedUsername('faq', setEnv)).toBe(false)
	await edit(removeReservedUsernames, ['brandnew'])
	expect((await loadReservedUsernameRecord(setEnv)).added).toEqual([])
	await expect(
		edit(removeReservedUsernames, ['kody', 'support']),
	).rejects.toBeInstanceOf(PermanentlyReservedUsernameError)

	const { sqlite, db } = createMigratedDb()
	const conflictStableId = await insertUser(sqlite, 'brandnew')
	const collideStableId = await insertUser(sqlite, 'fuckyou')
	expect(
		await findReservedUsernameConflicts(
			db,
			new Set(['brandnew', 'faq', 'fuck']),
			['fuck'],
		),
	).toEqual([
		{ username: 'brandnew', stableUserId: conflictStableId },
		{ username: 'fuckyou', stableUserId: collideStableId },
	])
})

test('admin snapshot confirms a write from another request env despite a warm validation memo', async () => {
	const { sqlite, db } = createMigratedDb()
	try {
		const kv = createMemoryKv()
		const reader = { ...createEnv(kv), APP_DB: db }
		const writer = { ...createEnv(kv), APP_DB: db }
		expect((await loadReservedUsernameRecord(reader)).added).toEqual([])
		await addReservedUsernames({
			env: writer,
			usernames: ['reserved-test'],
			updatedBy: 'admin-stable-id',
		})
		// The cached validation record demonstrates the independent env memo.
		expect((await loadReservedUsernameRecord(reader)).added).toEqual([])
		expect((await loadReservedUsernameAdminSnapshot(reader)).added).toEqual([
			'reserved-test',
		])
		await removeReservedUsernames({
			env: writer,
			usernames: ['reserved-test'],
			updatedBy: 'admin-stable-id',
		})
		expect((await loadReservedUsernameAdminSnapshot(reader)).added).toEqual([])
	} finally {
		sqlite.close()
	}
})
