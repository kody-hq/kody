import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { CredentialLoginFailedError } from './credential-request.ts'
import {
	obtainLoginSession,
	readStoredLoginSession,
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
	return { env }
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
