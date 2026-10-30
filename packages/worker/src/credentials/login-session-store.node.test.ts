import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { CredentialLoginFailedError } from './credential-request.ts'
import {
	obtainLoginSession,
	readStoredLoginSession,
	StaleLoginCredentialError,
} from './login-session-store.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const ownerId = ownerIdFromStored('org-token-demo')
const key = { ownerId, credentialId: 'cred-token-demo', revision: 'rev-1' }

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bucket-token-demo', ?, 'user', 'user')`,
		)
		.run(ownerId)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (id, bucket_id, name, encrypted_value, kind) VALUES (?, 'bucket-token-demo', 'token-demo', 'dummy-ciphertext', 'login')`,
		)
		.run(key.credentialId)
	const moveTo = (owner: string) =>
		sqlite
			.prepare(
				`UPDATE secret_buckets SET user_id = ? WHERE id = 'bucket-token-demo'`,
			)
			.run(owner)
	const deleteCredential = () =>
		sqlite
			.prepare(`UPDATE secret_entries SET deleted_at = 'now' WHERE id = ?`)
			.run(key.credentialId)
	return { env, moveTo, deleteCredential }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const hourFromNow = () => Date.now() + 3_600_000

test('concurrent callers in different isolates run one exchange and share its session', async () => {
	const { env } = setup()
	const gate = deferred<void>()
	let exchanges = 0
	const exchange = async () => {
		exchanges += 1
		await gate.promise
		return { token: `dummy-session-${exchanges}`, expiresAt: hourFromNow() }
	}
	const first = obtainLoginSession({ ...key, env, exchange, pollMs: 5 })
	await vi.waitFor(() => expect(exchanges).toBe(1))
	const second = obtainLoginSession({ ...key, env, exchange, pollMs: 5 })
	await new Promise((resolve) => setTimeout(resolve, 30))
	gate.resolve()

	const [a, b] = await Promise.all([first, second])
	expect(exchanges).toBe(1)
	expect(a).toMatchObject({
		source: 'new',
		session: { token: 'dummy-session-1' },
	})
	expect(b).toMatchObject({
		source: 'stored',
		session: { token: 'dummy-session-1' },
	})
})

test('a caller that claims the lease right after the holder publishes reuses that session', async () => {
	const { env } = setup()
	let exchanges = 0
	const exchange = async () => {
		exchanges += 1
		return { token: `dummy-session-${exchanges}`, expiresAt: hourFromNow() }
	}
	// The holder publishes and releases between this caller's read and claim.
	let raced = false
	const db = env.APP_DB
	const racingDb = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== 'prepare') return Reflect.get(target, prop, receiver)
			return (sql: string) => {
				const statement = target.prepare(sql)
				if (raced || !sql.trimStart().startsWith('SELECT')) return statement
				return {
					bind: (...values: Array<unknown>) => {
						const bound = statement.bind(...values)
						return {
							first: async () => {
								const row = await bound.first()
								raced = true
								await obtainLoginSession({ ...key, env, exchange })
								return row
							},
						}
					},
				}
			}
		},
	})
	const result = await obtainLoginSession({
		...key,
		env: { ...env, APP_DB: racingDb } as unknown as Env,
		exchange,
	})
	expect(exchanges).toBe(1)
	expect(result).toMatchObject({
		source: 'stored',
		session: { token: 'dummy-session-1' },
	})
})

test("a crashed holder's lease lapses and the next caller runs the exchange", async () => {
	const { env } = setup()
	await env.APP_DB.prepare(
		`INSERT INTO login_credential_sessions
			(credential_id, user_id, lease_id, lease_expires_at, updated_at)
		VALUES (?, ?, 'crashed-holder', ?, ?)`,
	)
		.bind(key.credentialId, ownerId, Date.now() + 40, new Date().toISOString())
		.run()
	let exchanges = 0
	const result = await obtainLoginSession({
		...key,
		env,
		leaseMs: 200,
		pollMs: 5,
		exchange: async () => {
			exchanges += 1
			return { token: 'dummy-session', expiresAt: hourFromNow() }
		},
	})
	expect(exchanges).toBe(1)
	expect(result.source).toBe('new')
	expect(await readStoredLoginSession({ ...key, env })).toMatchObject({
		token: 'dummy-session',
	})
})

test('a waiter gives up after twice the lease when the holder never finishes', async () => {
	const { env } = setup()
	await env.APP_DB.prepare(
		`INSERT INTO login_credential_sessions
			(credential_id, user_id, lease_id, lease_expires_at, updated_at)
		VALUES (?, ?, 'stuck-holder', ?, ?)`,
	)
		.bind(
			key.credentialId,
			ownerId,
			Date.now() + 60_000,
			new Date().toISOString(),
		)
		.run()
	const exchange = vi.fn()
	await expect(
		obtainLoginSession({ ...key, env, exchange, leaseMs: 20, pollMs: 5 }),
	).rejects.toBeInstanceOf(CredentialLoginFailedError)
	expect(exchange).not.toHaveBeenCalled()
})

test('a failed exchange releases the lease and stores nothing', async () => {
	const { env } = setup()
	await expect(
		obtainLoginSession({
			...key,
			env,
			exchange: async () => {
				throw new CredentialLoginFailedError(401)
			},
		}),
	).rejects.toBeInstanceOf(CredentialLoginFailedError)
	const row = await env.APP_DB.prepare(
		`SELECT lease_id, session_encrypted FROM login_credential_sessions`,
	).first()
	expect(row).toEqual({ lease_id: null, session_encrypted: null })
	const next = await obtainLoginSession({
		...key,
		env,
		exchange: async () => ({
			token: 'dummy-session',
			expiresAt: hourFromNow(),
		}),
	})
	expect(next.source).toBe('new')
})

test('a stored session is bound to its revision and owner, and is never stored in plaintext', async () => {
	const { env } = setup()
	await obtainLoginSession({
		...key,
		env,
		exchange: async () => ({
			token: 'dummy-session-secret',
			expiresAt: hourFromNow(),
		}),
	})
	const raw = await env.APP_DB.prepare(
		`SELECT * FROM login_credential_sessions`,
	).first()
	expect(JSON.stringify(raw)).not.toContain('dummy-session-secret')
	expect(await readStoredLoginSession({ ...key, env })).toMatchObject({
		token: 'dummy-session-secret',
	})
	expect(
		await readStoredLoginSession({ ...key, revision: 'rev-2', env }),
	).toBeNull()
	expect(
		await readStoredLoginSession({
			...key,
			ownerId: ownerIdFromStored('org-other'),
			env,
		}),
	).toBeNull()
	// Ciphertext moved to another revision's row does not decrypt.
	await env.APP_DB.prepare(
		`UPDATE login_credential_sessions SET revision = 'rev-2'`,
	).run()
	expect(
		await readStoredLoginSession({ ...key, revision: 'rev-2', env }),
	).toBeNull()
})

test('after an org transfer the new owner claims the row and mints its own session', async () => {
	const { env, moveTo } = setup()
	await obtainLoginSession({
		...key,
		env,
		exchange: async () => ({
			token: 'dummy-old-owner',
			expiresAt: hourFromNow(),
		}),
	})
	const newOwner = ownerIdFromStored('org-token-demo-target')
	moveTo(newOwner)
	const exchange = vi.fn(async () => ({
		token: 'dummy-new-owner',
		expiresAt: hourFromNow(),
	}))
	const result = await obtainLoginSession({
		...key,
		ownerId: newOwner,
		revision: 'rev-resealed',
		env,
		exchange,
	})
	expect(result).toMatchObject({
		source: 'new',
		session: { token: 'dummy-new-owner' },
	})
	expect(exchange).toHaveBeenCalledTimes(1)
	expect(
		await readStoredLoginSession({
			...key,
			ownerId: newOwner,
			revision: 'rev-resealed',
			env,
		}),
	).toMatchObject({ token: 'dummy-new-owner' })
	expect(await readStoredLoginSession({ ...key, env })).toBeNull()
})

test('an expired session is not reused', async () => {
	const { env } = setup()
	await obtainLoginSession({
		...key,
		env,
		exchange: async () => ({
			token: 'dummy-session',
			expiresAt: Date.now() + 20,
		}),
	})
	await new Promise((resolve) => setTimeout(resolve, 30))
	expect(await readStoredLoginSession({ ...key, env })).toBeNull()
})

test('a deleted credential gets no lease and no session, without waiting', async () => {
	const { env, deleteCredential } = setup()
	deleteCredential()
	const exchange = vi.fn(async () => ({
		token: 'dummy-session',
		expiresAt: hourFromNow(),
	}))
	const started = Date.now()
	await expect(
		obtainLoginSession({ ...key, env, exchange, leaseMs: 60_000 }),
	).rejects.toBeInstanceOf(CredentialLoginFailedError)
	expect(Date.now() - started).toBeLessThan(5_000)
	expect(exchange).not.toHaveBeenCalled()
	const rows = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS n FROM login_credential_sessions`,
	).first<{ n: number }>()
	expect(rows?.n).toBe(0)
})

test('a failed session write releases the lease', async () => {
	const { env } = setup()
	const db = env.APP_DB
	const failingDb = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== 'prepare') return Reflect.get(target, prop, receiver)
			return (sql: string) => {
				if (sql.includes('SET revision = ?'))
					throw new Error('dummy write failure')
				return target.prepare(sql)
			}
		},
	})
	await expect(
		obtainLoginSession({
			...key,
			env: { ...env, APP_DB: failingDb } as unknown as Env,
			exchange: async () => ({
				token: 'dummy-session',
				expiresAt: hourFromNow(),
			}),
		}),
	).rejects.toThrow('dummy write failure')
	const row = await db
		.prepare(
			`SELECT lease_id FROM login_credential_sessions WHERE credential_id = ?`,
		)
		.bind(key.credentialId)
		.first<{ lease_id: string | null }>()
	expect(row?.lease_id).toBeNull()
})

test('a stale caller releases the lease without exchanging', async () => {
	const { env } = setup()
	const exchange = vi.fn(async () => ({
		token: 'dummy-session',
		expiresAt: hourFromNow(),
	}))
	await expect(
		obtainLoginSession({
			...key,
			env,
			exchange,
			isCurrent: async () => false,
		}),
	).rejects.toBeInstanceOf(StaleLoginCredentialError)
	expect(exchange).not.toHaveBeenCalled()
	const row = await env.APP_DB.prepare(
		`SELECT lease_id FROM login_credential_sessions WHERE credential_id = ?`,
	)
		.bind(key.credentialId)
		.first<{ lease_id: string | null }>()
	expect(row?.lease_id).toBeNull()
})
