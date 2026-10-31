import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	checkPackageAppRateLimit,
	packageAppRateLimitStorageKey,
} from './package-app-rate-limit.ts'

test('package app rate limit enforces a fixed window and resets at its boundary', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE package_app_rate_limits (
			bucket_key TEXT PRIMARY KEY,
			window_start INTEGER NOT NULL,
			count INTEGER NOT NULL
		)`,
	)
	const db = createD1FromSqlite(sqlite)
	const options = {
		db,
		packageId: 'package-a',
		key: 'export-task',
		limit: 2,
		windowSeconds: 60,
		nowMilliseconds: 120_001,
	}

	await expect(checkPackageAppRateLimit(options)).resolves.toMatchObject({
		allowed: true,
		remaining: 1,
		resetAt: '1970-01-01T00:03:00.000Z',
	})
	await expect(checkPackageAppRateLimit(options)).resolves.toMatchObject({
		allowed: true,
		remaining: 0,
	})
	await expect(checkPackageAppRateLimit(options)).resolves.toEqual({
		allowed: false,
		remaining: 0,
		resetAt: '1970-01-01T00:03:00.000Z',
		retryAfterSeconds: 60,
	})
	await expect(
		checkPackageAppRateLimit({
			...options,
			nowMilliseconds: 180_000,
		}),
	).resolves.toEqual({
		allowed: true,
		remaining: 1,
		resetAt: '1970-01-01T00:04:00.000Z',
		retryAfterSeconds: null,
	})

	sqlite.close()
})

test('package app rate limits isolate package ids and store only a hash of the key', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE package_app_rate_limits (
			bucket_key TEXT PRIMARY KEY,
			window_start INTEGER NOT NULL,
			count INTEGER NOT NULL
		)`,
	)
	const db = createD1FromSqlite(sqlite)
	const options = {
		db,
		packageId: 'package-a',
		key: 'private-user-key',
		limit: 1,
		windowSeconds: 60,
		nowMilliseconds: 120_001,
	}

	await expect(checkPackageAppRateLimit(options)).resolves.toMatchObject({
		allowed: true,
	})
	await expect(
		checkPackageAppRateLimit({ ...options, packageId: 'package-b' }),
	).resolves.toMatchObject({ allowed: true })
	await expect(checkPackageAppRateLimit(options)).resolves.toMatchObject({
		allowed: false,
	})
	const storedKeys = sqlite
		.prepare(`SELECT bucket_key FROM package_app_rate_limits`)
		.all()
		.map((row) => row.bucket_key as string)
	expect(storedKeys.every((key) => !key.includes('private-user-key'))).toBe(
		true,
	)
	expect(storedKeys).toContain(
		await packageAppRateLimitStorageKey('package-a', 'private-user-key', 60),
	)

	sqlite.close()
})

test('package app rate limits validate the documented bounds', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE package_app_rate_limits (
			bucket_key TEXT PRIMARY KEY,
			window_start INTEGER NOT NULL,
			count INTEGER NOT NULL
		)`,
	)
	const db = createD1FromSqlite(sqlite)
	const base = {
		db,
		packageId: 'package-a',
		key: 'task',
		limit: 1,
		windowSeconds: 60,
	}

	for (const invalid of [
		{ limit: 0 },
		{ limit: 1_000_001 },
		{ windowSeconds: 0 },
		{ windowSeconds: 86_401 },
		{ key: 'x'.repeat(257) },
	]) {
		await expect(
			checkPackageAppRateLimit({ ...base, ...invalid }),
		).rejects.toThrow('appRateLimit received invalid arguments.')
	}
})
