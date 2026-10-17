import { startWebsiteOAuth } from '#worker/identity/oauth-start-operation.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'

export const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

export function applyMigrations(db: DatabaseSync) {
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))
}

export function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

export async function seedUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		stableUserId?: string
		emailVerified?: boolean
	},
) {
	const passwordHash = await createPasswordHash('test-password')
	const stableUserId =
		input.stableUserId ?? testStableUserIdFromEmail(input.email)
	const verifiedAt = input.emailVerified ? 'CURRENT_TIMESTAMP' : 'NULL'
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			${verifiedAt}
		);
	`)
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId,
		username: input.username,
	})
}

export function createAppEnv(
	db: D1Database,
	overrides: Record<string, unknown> = {},
): Env {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		GITHUB_CLIENT_ID: 'github-client-id-test',
		GITHUB_CLIENT_SECRET: 'github-client-secret-test',
		GOOGLE_CLIENT_ID: 'google-client-id-test',
		GOOGLE_CLIENT_SECRET: 'google-client-secret-test',
		X_CLIENT_ID: 'x-client-id-test',
		X_CLIENT_SECRET: 'x-client-secret-test',
		DISCORD_CLIENT_ID: 'discord-client-id-test',
		DISCORD_CLIENT_SECRET: 'discord-client-secret-test',
		...overrides,
	} as unknown as Env
}

export function createMemoryKv(initial?: Record<string, string>) {
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
		store,
	} as unknown as KVNamespace
}

export async function runHandler<Params extends Record<string, string>>(
	handler: (input: { request: Request; params: Params }) => Promise<Response>,
	request: Request,
	params: Params,
): Promise<Response> {
	return handler({
		request,
		params,
	})
}

export function getCookiePair(setCookieHeader: string) {
	const pair = setCookieHeader.split(';')[0]
	if (!pair) throw new Error(`Unexpected Set-Cookie header: ${setCookieHeader}`)
	return pair
}

export async function startProviderFlow(
	env: Env,
	provider: string,
	url: string,
) {
	const startResponse = await startWebsiteOAuth({
		env,
		provider,
		url: new URL(url),
		request: new Request(url),
		body: {},
	})
	expect(startResponse.status).toBe(200)
	if (!('authorizeUrl' in startResponse.data))
		throw new Error('Expected OAuth authorization URL')
	const location = startResponse.data.authorizeUrl
	const stateCookie = getCookiePair(
		startResponse.headers.get('Set-Cookie') ?? '',
	)
	const state = new URL(location).searchParams.get('state') ?? ''
	return { location, stateCookie, state }
}
