import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import { testAccountEmailDestinationsHandler } from './account-email-destinations.test-support.ts'

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
	input: { verified?: boolean } = {},
) {
	const email = 'owner@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1,
			'owner',
			${quoteSqlString(email)},
			${quoteSqlString(stableUserId)},
			'test-password-hash',
			${input.verified === false ? 'NULL' : 'CURRENT_TIMESTAMP'}
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
	} as unknown as Parameters<typeof testAccountEmailDestinationsHandler>[0]
}

async function runHandler(
	handler: ReturnType<typeof testAccountEmailDestinationsHandler>,
	request: Request,
) {
	return handler.execute({
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

test('account destination operations persist writes, return outcomes, and reject unverified defaults and accounts', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite)
	const handler = testAccountEmailDestinationsHandler(createAppEnv(db))
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
	expect(listed.data).toMatchObject({
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
	expect(added.data).toEqual({
		ok: true,
		message:
			'Verification email sent. Open the link to start using this address.',
	})
	const refreshed = await runHandler(
		handler,
		await createRequest({ session, method: 'GET' }),
	)
	expect(refreshed.data).toMatchObject({
		destinations: [
			{ email: 'owner@example.com' },
			{ email: 'phone@example.com', verified: false },
		],
	})
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
	const resentBody = resent.data as { message: string }
	expect(resentBody.message).toContain('sent again')
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get() as { count: number },
	).toEqual({ count: 2 })

	const destination = sqlite
		.prepare('SELECT id FROM email_notification_destinations WHERE email = ?')
		.get('phone@example.com') as { id: string }
	const unverifiedDefault = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'setDefault', id: destination.id },
		}),
	)
	expect(unverifiedDefault.status).toBe(400)
	sqlite
		.prepare(
			'UPDATE email_notification_destinations SET verified_at = CURRENT_TIMESTAMP WHERE id = ?',
		)
		.run(destination.id)
	const changed = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'setDefault', id: destination.id },
		}),
	)
	expect(changed.data).toEqual({
		ok: true,
		message: 'Default email destination updated.',
	})
	expect(
		sqlite
			.prepare(
				'SELECT is_default FROM email_notification_destinations WHERE id = ?',
			)
			.get(destination.id),
	).toEqual({ is_default: 1 })
	const removed = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'remove', id: destination.id },
		}),
	)
	expect(removed.data).toEqual({
		ok: true,
		message: 'Email destination removed.',
	})
	expect(
		sqlite
			.prepare('SELECT id FROM email_notification_destinations WHERE id = ?')
			.get(destination.id),
	).toBeUndefined()

	const { sqlite: unverifiedSqlite, db: unverifiedDb } = createMigratedDb()
	await seedUser(unverifiedSqlite, { verified: false })
	const unverifiedHandler = testAccountEmailDestinationsHandler(
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
