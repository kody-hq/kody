import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { testAccountSecretProvidersApiHandler } from '#app/handlers/account-secret-providers.test-support.ts'
import { grantSecretProviderToPackage } from '#mcp/secrets/secret-providers/service.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const canonicalRef = `i/${itemId}/password`
const ownerEmail = 'one@example.com'
const ownerStableId = testStableUserIdFromEmail(ownerEmail)

async function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string; username: string },
) {
	const passwordHash = await createPasswordHash('test-password')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(testStableUserIdFromEmail(input.email))},
			${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
	`)
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: testStableUserIdFromEmail(input.email),
		username: input.username,
	})
}

function seedPackage(
	sqlite: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.kodyId,
			input.kodyId,
			'',
			`source-${input.id}`,
		)
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		SENTRY_ENVIRONMENT: 'test',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
}

type Handler = {
	execute(
		context: never,
	): Promise<{ data: unknown; status: number; headers?: HeadersInit }>
}

async function runHandler(handler: Handler, request: Request) {
	return handler.execute({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

const ownerSession: AuthSession = {
	stableUserId: ownerStableId,
	email: ownerEmail,
	rememberMe: false,
}

test('secret providers API lists grants and revokes them on the website', async () => {
	setAuthSessionSecret(testCookieSecret)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = createAppEnv(db)
	await seedUser(sqlite, { id: 1, email: ownerEmail, username: 'one' })
	seedPackage(sqlite, {
		id: 'pkg-provider',
		userId: ownerStableId,
		kodyId: 'op',
	})
	seedPackage(sqlite, {
		id: 'pkg-consumer',
		userId: ownerStableId,
		kodyId: 'deploy',
	})
	sqlite
		.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, ?, ?, ?, '{}')`,
		)
		.run(
			ownerStableId,
			'1password',
			'pkg-provider',
			'onePasswordServiceAccountToken',
		)
	await grantSecretProviderToPackage({
		env,
		userId: ownerIdFromStored(ownerStableId),
		providerId: '1password',
		ref: canonicalRef,
		packageId: 'pkg-consumer',
	})
	const handler = testAccountSecretProvidersApiHandler(env)
	const cookie = await createAuthCookie(ownerSession, false)

	const listed = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			headers: { Cookie: cookie, Accept: 'application/json' },
		}),
	)
	expect(listed.status).toBe(200)
	const listedPayload = listed.data as {
		ok: boolean
		grants: Array<{
			provider: string
			canonicalRef: string
			packageId: string
			kodyId: string
		}>
	}
	expect(listedPayload.ok).toBe(true)
	expect(listedPayload.grants).toEqual([
		{
			provider: '1password',
			canonicalRef,
			packageId: 'pkg-consumer',
			kodyId: 'deploy',
			createdAt: expect.any(String),
		},
	])

	const revoked = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			method: 'POST',
			headers: {
				Cookie: cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'revoke',
				provider: '1password',
				ref: canonicalRef,
				packageId: 'pkg-consumer',
			}),
		}),
	)
	expect(revoked.status).toBe(200)

	const afterRevoke = await runHandler(
		handler,
		new Request('http://example.com/account/secret-providers.json', {
			headers: { Cookie: cookie, Accept: 'application/json' },
		}),
	)
	const afterPayload = afterRevoke.data as {
		grants: Array<unknown>
	}
	expect(afterPayload.grants).toEqual([])
})
