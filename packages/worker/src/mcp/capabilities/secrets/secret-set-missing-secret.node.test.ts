/**
 * secretSet without a value updates an existing secret. On a secret that does
 * not exist (KODY-F5) it must fail as a caller error that says how to create
 * it, not as an opaque internal error that opens a Sentry issue.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import { secretSetCapability } from './secret-set.ts'

const now = '2026-11-16T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')!
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (1, 'owneruser', 'owneruser@example.com', 'h', ?, ?, ?)`,
		)
		.bind(now, now, ownerId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: ownerId,
		username: 'owneruser',
		createdAt: now,
	})
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const org = ownerIdFromStored(ownerId)
	const ctx = {
		env,
		openApiPrincipal: { kind: 'mcp' } as const,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(ownerId),
				email: 'owneruser@example.com',
				displayName: 'owneruser',
				username: 'owneruser',
			},
			orgBinding: { org: { id: org, slug: 'owneruser' }, role: 'owner' },
		}),
	}
	return { ctx }
}

async function failure(promise: Promise<unknown>) {
	return await promise.then(
		() => {
			throw new Error('Expected secretSet to fail.')
		},
		(error: unknown) => error,
	)
}

test('secretSet without a value on a missing secret is a caller error with a create hint', async () => {
	const { ctx } = await setup()
	await secretSetCapability.handler(
		{ name: 'existingToken', scope: 'user', value: 'stored-value' },
		ctx,
	)

	for (const input of [
		{ name: 'missingToken', scope: 'user', description: 'Updated' },
		{ name: 'missingToken', scope: 'user', expires_at: '2027-01-01' },
	]) {
		const error = await failure(secretSetCapability.handler(input, ctx))
		expect(error).toBeInstanceOf(McpCallerError)
		const message = (error as Error).message
		expect(message).toContain('Secret "missingToken" not found in user scope.')
		expect(message).toContain('pass a non-empty `value` to create it')
		expect(message).toContain('secretList')
		expect(toApiError(error).status).toBe(404)
	}

	const created = await secretSetCapability.handler(
		{ name: 'missingToken', scope: 'user', value: 'new-value' },
		ctx,
	)
	expect(created).toMatchObject({ name: 'missingToken', scope: 'user' })
})
