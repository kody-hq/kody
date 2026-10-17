import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'
import { createAccountEmailDestinationsHandler } from './account-email-destinations.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedUser(
	sqlite: DatabaseSync,
	input: { verified?: boolean; createdAtSql?: string } = {},
) {
	const email = 'owner@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const createdAtSql = input.createdAtSql ?? "datetime('now', '-48 hours')"
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at,
			created_at
		) VALUES (
			1,
			'owner',
			${quoteSqlString(email)},
			${quoteSqlString(stableUserId)},
			'test-password-hash',
			${input.verified === false ? 'NULL' : 'CURRENT_TIMESTAMP'},
			${createdAtSql}
		);
	`)
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId,
		username: 'owner',
	})
	return stableUserId
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAccountEmailDestinationsHandler>[0]
}

async function runHandler(
	handler: ReturnType<typeof createAccountEmailDestinationsHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

async function createRequest(input: {
	session: AuthSession
	method?: 'GET' | 'POST'
	body?: Record<string, string>
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/email-destinations.json', {
		method: input.method ?? 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: input.body ? JSON.stringify(input.body) : undefined,
	})
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account destination API lists identity, adds a pending extra, and blocks unverified accounts from mutating', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite)
	const handler = createAccountEmailDestinationsHandler(createAppEnv(db))
	const session = {
		stableUserId: testStableUserIdFromEmail('owner@example.com'),
		email: 'owner@example.com',
		rememberMe: false,
	}

	const listed = await runHandler(
		handler,
		await createRequest({ session, method: 'GET' }),
	)
	expect(listed.status).toBe(200)
	expect(await listed.json()).toMatchObject({
		ok: true,
		additionalLimit: 5,
		additionalRemaining: 5,
		destinations: [
			{
				id: identityEmailDestinationId,
				email: 'owner@example.com',
				kind: 'identity',
				verified: true,
				isDefault: true,
				canRemove: false,
			},
		],
	})

	const added = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'add', email: 'Phone@Example.com' },
		}),
	)
	expect(added.status).toBe(200)
	const addedBody = (await added.json()) as {
		destinations: Array<{ email: string; verified: boolean }>
		message: string
	}
	expect(
		addedBody.destinations.map((destination) => destination.email),
	).toEqual(['owner@example.com', 'phone@example.com'])
	expect(addedBody.destinations[1]?.verified).toBe(false)
	expect(addedBody.message).toContain('Verification email sent')
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get() as { count: number },
	).toEqual({ count: 1 })

	const resent = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'add', email: 'phone@example.com' },
		}),
	)
	expect(resent.status).toBe(200)
	const resentBody = (await resent.json()) as { message: string }
	expect(resentBody.message).toContain('sent again')
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get() as { count: number },
	).toEqual({ count: 2 })

	const { sqlite: unverifiedSqlite, db: unverifiedDb } = createMigratedDb()
	await seedUser(unverifiedSqlite, { verified: false })
	const unverifiedHandler = createAccountEmailDestinationsHandler(
		createAppEnv(unverifiedDb),
	)
	const unverified = await runHandler(
		unverifiedHandler,
		await createRequest({
			session,
			body: { action: 'add', email: 'other@example.com' },
		}),
	)
	expect(unverified.status).toBe(403)
})

test('account destination API blocks new accounts with the signup wait', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, { createdAtSql: "datetime('now', '-30 minutes')" })
	const handler = createAccountEmailDestinationsHandler(createAppEnv(db))
	const response = await runHandler(
		handler,
		await createRequest({
			session: {
				stableUserId: testStableUserIdFromEmail('owner@example.com'),
				email: 'owner@example.com',
				rememberMe: false,
			},
			body: { action: 'add', email: 'phone@example.com' },
		}),
	)
	expect(response.status).toBe(403)
	expect(response.headers.get('Retry-After')).toMatch(/^\d+$/)
	expect(await response.json()).toMatchObject({
		ok: false,
		error: expect.stringMatching(
			/New accounts can add email destinations 24 hours after signup\. Try again after .+ UTC/,
		),
	})
})
