import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { setFeatureFlagGlobalState } from '#worker/feature-flags/service.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	allowDuringAllowedPackagesSafetyWindow,
	isAllowedPackagesSafetyWindowActive,
} from './allowed-packages-safety-window.ts'

const owner = ownerIdFromStored('owner-1')
const cutoverAt = '2026-12-02T00:00:00.000Z'
const inWindow = new Date('2026-11-10T00:00:00.000Z')

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	// The flag write names an admin user this fixture does not seed.
	sqlite.exec('PRAGMA foreign_keys = OFF')
	sqlite.exec(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('b1', '${owner}', 'user', '')`,
	)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (bucket_id, id, name, encrypted_value, allowed_packages, created_at) VALUES ('b1', 'cred-old', 'OLD', 'x', '["pkg-other"]', '2026-10-01 00:00:00')`,
		)
		.run()
	const db = createD1FromSqlite(sqlite)
	return { sqlite, db, env: { APP_DB: db } as unknown as Env }
}

function allow(
	env: Env,
	overrides: Partial<
		Parameters<typeof allowDuringAllowedPackagesSafetyWindow>[0]
	> = {},
) {
	return allowDuringAllowedPackagesSafetyWindow({
		env,
		ownerId: owner,
		credentialId: 'cred-old',
		packageId: 'pkg-1',
		accessKind: 'self_authored',
		now: inWindow,
		cutoverAt,
		...overrides,
	})
}

function allowedPackages(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			`SELECT allowed_packages FROM secret_entries WHERE id = 'cred-old'`,
		)
		.get()
}

async function setFlag(db: D1Database, enabled: boolean) {
	await setFeatureFlagGlobalState(db, {
		key: 'credential-allowed-packages-safety-window',
		enabled,
		rolloutPercent: null,
		updatedBy: 1,
	})
}

afterEach(() => {
	vi.restoreAllMocks()
})

test('flag off: nothing is allowed', async () => {
	const { env, db, sqlite } = setup()
	await setFlag(db, false)
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	await expect(allow(env)).resolves.toBe(false)
	expect(info).not.toHaveBeenCalled()
	expect(allowedPackages(sqlite)).toEqual({ allowed_packages: '["pkg-other"]' })
})

test('flag on in the window: allowed and logged, the list is never written', async () => {
	const { env, db, sqlite } = setup()
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	await expect(
		isAllowedPackagesSafetyWindowActive({ db, now: inWindow, cutoverAt }),
	).resolves.toBe(true)
	await expect(allow(env)).resolves.toBe(true)
	await expect(allow(env, { accessKind: 'adopted' })).resolves.toBe(true)
	expect(info).toHaveBeenCalledTimes(2)
	expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
		event: 'credential_allowed_packages_safety_window_allow',
		ownerId: owner,
		credentialId: 'cred-old',
		packageId: 'pkg-1',
		accessKind: 'self_authored',
	})
	expect(allowedPackages(sqlite)).toEqual({ allowed_packages: '["pkg-other"]' })
})

test('an owner removal during the window sticks across later uses (#4637)', async () => {
	const { env, sqlite } = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	sqlite
		.prepare(
			`UPDATE secret_entries SET allowed_packages = '["pkg-1","pkg-other"]' WHERE id = 'cred-old'`,
		)
		.run()
	sqlite
		.prepare(
			`UPDATE secret_entries SET allowed_packages = '["pkg-other"]' WHERE id = 'cred-old'`,
		)
		.run()
	await expect(allow(env)).resolves.toBe(true)
	await expect(allow(env)).resolves.toBe(true)
	expect(allowedPackages(sqlite)).toEqual({ allowed_packages: '["pkg-other"]' })
})

test('at cutover the rule is strict even with the flag on', async () => {
	const { env, db } = setup()
	await expect(
		isAllowedPackagesSafetyWindowActive({
			db,
			now: new Date(cutoverAt),
			cutoverAt,
		}),
	).resolves.toBe(false)
	await expect(allow(env, { now: new Date(cutoverAt) })).resolves.toBe(false)
})
