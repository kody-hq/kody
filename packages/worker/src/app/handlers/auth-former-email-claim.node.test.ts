import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test, vi } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import {
	formerEmailClaimedSignupCode,
	formerEmailClaimedSignupMessage,
} from '#universal/email-claim-errors.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const conflictMessage = formerEmailClaimedSignupMessage

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../../migrations/', import.meta.url)
	applyAllMigrations(db, migrationsDir)
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedFormerEmailClaim(
	sqlite: DatabaseSync,
	input: { currentEmail: string; username: string; claimedEmail: string },
) {
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (
			1,
			${quoteSqlString(input.username)},
			${quoteSqlString(input.currentEmail)},
			${quoteSqlString('a'.repeat(64))},
			'hash'
		);
		INSERT INTO user_email_claims (user_id, email, status, claimed_at, updated_at)
		VALUES (1, ${quoteSqlString(input.claimedEmail)}, 'claimed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
	`)
}

function createHandler(db: D1Database) {
	return createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: db,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAuthHandler>[0])
}

async function signup(
	handler: ReturnType<typeof createAuthHandler>,
	body: Record<string, unknown>,
) {
	const request = new Request('http://example.com/auth', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	return handler({ request: request })
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('signup returns 409 when another account claims the email', async () => {
	const claimedEmail = 'former@example.com'
	const { sqlite, db } = createMigratedDb()
	seedFormerEmailClaim(sqlite, {
		currentEmail: 'current@example.com',
		username: 'current',
		claimedEmail,
	})
	const openHandler = createHandler(db)

	const openResponse = await signup(openHandler, {
		email: claimedEmail,
		username: 'newcomer',
		password: 'password123',
		mode: 'signup',
	})
	expect(openResponse.status).toBe(409)
	expect(await openResponse.json()).toEqual({
		error: conflictMessage,
		code: formerEmailClaimedSignupCode,
	})
	expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get()).toEqual({
		count: 1,
	})
	expect(lifecycleMocks.scheduleUserCreatedEvent).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'signup',
			result: 'failure',
			reason: 'former_email_claimed',
		}),
	)
	expect(auditEventSummaries()).toEqual(['signup:failure'])
})

test('signup mints a random id when the email hash matches a legacy account', async () => {
	const email = 'legacy-original@example.com'
	const { sqlite, db } = createMigratedDb()
	const legacyStableUserId = createHash('sha256').update(email).digest('hex')
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (1, 'legacy', 'legacy-now@example.com', ${quoteSqlString(legacyStableUserId)}, 'hash');
	`)

	const response = await signup(createHandler(db), {
		email,
		username: 'newcomer-legacy',
		password: 'password123',
		mode: 'signup',
	})
	expect(response.status).toBe(200)
	const created = sqlite
		.prepare(`SELECT stable_user_id FROM users WHERE email = ?`)
		.get(email) as { stable_user_id: string }
	expect(created.stable_user_id).toMatch(/^[a-f0-9]{64}$/)
	expect(created.stable_user_id).not.toBe(legacyStableUserId)
})
