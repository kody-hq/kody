import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	getSecretBucket,
	getSecretEntry,
	getStoredCredentialEntry,
	listPackageScopeSecretMetadata,
	listSecretBucketsByScope,
} from './repo.ts'

function createSecretsDb(options?: {
	maxBindings?: number
	queries?: Array<string>
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite, options),
	}
}

function isSecretBucketLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from secret_buckets') &&
		normalized.includes('user_id = ?') &&
		normalized.includes('scope = ?') &&
		normalized.includes('binding_key = ?')
	)
}

function isSecretEntrySingleLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from secret_entries') &&
		normalized.includes('bucket_id = ?') &&
		normalized.includes('name = ?') &&
		!normalized.includes('name in (')
	)
}

function isSecretEntryBatchLookup(query: string) {
	const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
	return (
		normalized.includes('from secret_entries') &&
		normalized.includes('bucket_id = ?') &&
		normalized.includes('name in (')
	)
}

function insertPackageSecret(
	sqlite: DatabaseSync,
	input: {
		bucketId: string
		userId: string
		packageId: string
		name: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES (?, ?, 'package', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
		)
		.run(input.bucketId, input.userId, input.packageId)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, description, encrypted_value,
				allowed_hosts, allowed_packages,
				created_at, updated_at
			) VALUES (?, ?, '', 'ciphertext', '[]', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
		)
		.run(input.bucketId, input.name)
}

test('getSecretBucket shares one D1 read for concurrent identical lookups (KODY-9K)', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createSecretsDb({ queries })
	const userId = ownerIdFromStored('user-bucket-dedupe')
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-user', '${userId}', 'user', '');
	`)
	queries.length = 0

	const results = await Promise.all(
		Array.from({ length: 6 }, () =>
			getSecretBucket({
				db,
				userId,
				scope: 'user',
				bindingKey: '',
				now: '2026-10-17T00:00:00.000Z',
			}),
		),
	)
	expect(results.every((bucket) => bucket?.id === 'bucket-user')).toBe(true)
	expect(queries.filter(isSecretBucketLookup)).toHaveLength(1)

	await expect(
		getSecretBucket({
			db,
			userId,
			scope: 'user',
			bindingKey: '',
			now: '2026-10-17T00:00:00.000Z',
		}),
	).resolves.toEqual(expect.objectContaining({ id: 'bucket-user' }))
	expect(queries.filter(isSecretBucketLookup)).toHaveLength(2)
})

test('getSecretBucket rechecks expiry for callers that share an in-flight load', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createSecretsDb({ queries })
	const userId = ownerIdFromStored('user-bucket-expiry')
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key, expires_at)
		VALUES (
			'bucket-expiring',
			'${userId}',
			'user',
			'',
			'2026-10-17T12:00:00.000Z'
		);
	`)
	queries.length = 0

	let releaseLookup: (() => void) | undefined
	const lookupGate = new Promise<void>((resolve) => {
		releaseLookup = resolve
	})
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		if (!isSecretBucketLookup(query)) return statement
		const originalFirst = statement.first.bind(statement)
		statement.first = (async () => {
			await lookupGate
			return originalFirst()
		}) as typeof statement.first
		return statement
	}) as typeof db.prepare

	const early = getSecretBucket({
		db,
		userId,
		scope: 'user',
		bindingKey: '',
		now: '2026-10-17T11:59:00.000Z',
	})
	const late = getSecretBucket({
		db,
		userId,
		scope: 'user',
		bindingKey: '',
		now: '2026-10-17T12:00:01.000Z',
	})
	releaseLookup?.()
	expect(await early).toEqual(
		expect.objectContaining({ id: 'bucket-expiring' }),
	)
	expect(await late).toBeNull()
	expect(queries.filter(isSecretBucketLookup)).toHaveLength(1)
})

test('getSecretEntry isolates one bucket failure from other buckets in the same flush', async () => {
	const { sqlite, db } = createSecretsDb()
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES
			('bucket-ok', 'org-isolate', 'user', ''),
			('bucket-bad', 'org-isolate', 'user', 'other');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value)
		VALUES
			('cred-ok', 'bucket-ok', 'GOOD', 'ct-ok'),
			('cred-bad', 'bucket-bad', 'BAD', 'ct-bad');
	`)

	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		if (isSecretEntrySingleLookup(query) || isSecretEntryBatchLookup(query)) {
			const originalBind = statement.bind.bind(statement)
			statement.bind = (...args: Array<unknown>) => {
				const bound = originalBind(...args)
				if (args[0] === 'bucket-bad') {
					const fail = async () => {
						throw new Error('simulated bucket-bad D1 failure')
					}
					bound.first = fail
					bound.all = fail
					bound.run = fail
				}
				return bound
			}
		}
		return statement
	}) as typeof db.prepare

	const [ok, bad] = await Promise.allSettled([
		getSecretEntry({ db, bucketId: 'bucket-ok', name: 'GOOD' }),
		getSecretEntry({ db, bucketId: 'bucket-bad', name: 'BAD' }),
	])
	expect(ok).toEqual({
		status: 'fulfilled',
		value: expect.objectContaining({ name: 'GOOD' }),
	})
	expect(bad.status).toBe('rejected')
	if (bad.status === 'rejected') {
		expect(bad.reason).toEqual(
			expect.objectContaining({ message: 'simulated bucket-bad D1 failure' }),
		)
	}
})

test('getSecretEntry batches concurrent names in one bucket into one IN read (KODY-9K)', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createSecretsDb({ queries })
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-user', 'org-batch', 'user', '');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value)
		VALUES
			('cred-a', 'bucket-user', 'ALPHA', 'ct-a'),
			('cred-b', 'bucket-user', 'BRAVO', 'ct-b'),
			('cred-c', 'bucket-user', 'CHARLIE', 'ct-c'),
			('cred-d', 'bucket-user', 'DELTA', 'ct-d'),
			('cred-e', 'bucket-user', 'ECHO', 'ct-e'),
			('cred-f', 'bucket-user', 'FOXTROT', 'ct-f');
	`)
	queries.length = 0

	const names = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT']
	const results = await Promise.all(
		names.map((name) => getSecretEntry({ db, bucketId: 'bucket-user', name })),
	)
	expect(results.map((entry) => entry?.name)).toEqual(names)
	expect(queries.filter(isSecretEntrySingleLookup)).toHaveLength(0)
	expect(queries.filter(isSecretEntryBatchLookup)).toHaveLength(1)

	queries.length = 0
	await expect(
		getSecretEntry({ db, bucketId: 'bucket-user', name: 'ALPHA' }),
	).resolves.toEqual(expect.objectContaining({ name: 'ALPHA' }))
	expect(queries.filter(isSecretEntrySingleLookup)).toHaveLength(1)
	expect(queries.filter(isSecretEntryBatchLookup)).toHaveLength(0)
})

test('listPackageScopeSecretMetadata chunks package ids to stay within the D1 binding limit', async () => {
	const { sqlite, db } = createSecretsDb({ maxBindings: maxD1BoundParameters })
	const userId = ownerIdFromStored('user-with-many-packages')
	const packageIds = Array.from(
		{ length: maxD1BoundParameters + 1 },
		(_, index) => `package-${String(index).padStart(3, '0')}`,
	)
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-first',
		userId,
		packageId: packageIds[0] ?? 'package-000',
		name: 'alpha-token',
	})
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-last',
		userId,
		packageId: packageIds.at(-1) ?? 'package-100',
		name: 'zeta-token',
	})

	const rows = await listPackageScopeSecretMetadata({
		db,
		userId,
		packageIds,
		now: '2026-08-31T00:00:00.000Z',
	})

	expect(rows).toEqual([
		expect.objectContaining({
			name: 'alpha-token',
			binding_key: 'package-000',
			scope: 'package',
		}),
		expect.objectContaining({
			name: 'zeta-token',
			binding_key: 'package-100',
			scope: 'package',
		}),
	])
})

test('listSecretBucketsByScope returns caller-owned package buckets only', async () => {
	const { sqlite, db } = createSecretsDb()
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-owned',
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-owned',
		name: 'owned-token',
	})
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-other',
		userId: ownerIdFromStored('user-2'),
		packageId: 'package-other',
		name: 'other-token',
	})

	const buckets = await listSecretBucketsByScope({
		db,
		userId: ownerIdFromStored('user-1'),
		scope: 'package',
		now: '2026-08-31T00:00:00.000Z',
	})

	expect(buckets).toEqual([
		expect.objectContaining({
			user_id: ownerIdFromStored('user-1'),
			scope: 'package',
			binding_key: 'package-owned',
		}),
	])
})

test('secret reads return the stored kind and exchange config', async () => {
	const { sqlite, db } = createSecretsDb()
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-user', 'org-user', 'user', ''),
			('bucket-pkg', 'org-user', 'package', 'pkg-1');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value)
		VALUES ('cred-openai', 'bucket-user', 'OPENAI_KEY', 'ct'),
			('cred-pkg', 'bucket-pkg', 'WEBHOOK', 'ct-pkg');
	`)
	const readStored = () =>
		getStoredCredentialEntry({
			db,
			ownerId: 'org-user',
			credentialId: 'cred-openai',
			now: '2026-10-12T00:00:00.000Z',
		})

	await expect(
		getSecretEntry({ db, bucketId: 'bucket-user', name: 'OPENAI_KEY' }),
	).resolves.toEqual(
		expect.objectContaining({ id: 'cred-openai', kind: 'secret' }),
	)
	await expect(readStored()).resolves.toEqual(
		expect.objectContaining({ kind: 'secret', config_json: null }),
	)
	// Package-bound Keys resolve by id for credential() after need auto-pick.
	await expect(
		getStoredCredentialEntry({
			db,
			ownerId: 'org-user',
			credentialId: 'cred-pkg',
			now: '2026-10-12T00:00:00.000Z',
		}),
	).resolves.toEqual(
		expect.objectContaining({
			id: 'cred-pkg',
			name: 'WEBHOOK',
			kind: 'secret',
		}),
	)

	sqlite.exec(
		`UPDATE secret_entries SET kind = 'login', config_json = '{}' WHERE id = 'cred-openai'`,
	)
	await expect(
		getSecretEntry({ db, bucketId: 'bucket-user', name: 'OPENAI_KEY' }),
	).resolves.toEqual(expect.objectContaining({ kind: 'login' }))
	await expect(readStored()).resolves.toEqual(
		expect.objectContaining({ kind: 'login', config_json: '{}' }),
	)
})
