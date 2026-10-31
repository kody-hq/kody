import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { type RequestSource } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { metaGetCurrentUserCapability } from './meta-get-current-user.ts'

const teamOrgUser = {
	userId: personIdFromStored('a'.repeat(64)),
	email: '',
	username: 'acme',
	displayName: 'Acme',
}

test('metaGetCurrentUser accepts an empty email for a team org caller', async () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		source: { kind: 'schedule', jobId: 'job-1' },
		user: teamOrgUser,
	})
	const result = await metaGetCurrentUserCapability.handler(
		{},
		{ env: {} as Env, callerContext },
	)
	expect(result.email).toBe('')
	expect(result.org).toEqual({ slug: 'acme' })
})

test('metaGetCurrentUser reports a member sender only while that account is live and in the org', async () => {
	const beaId = 'b'.repeat(64)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, display_name, stable_user_id)
			 VALUES ('bea', 'bea@acme.example', 'hash', 'Bea', ?)`,
		)
		.bind(beaId)
		.run()

	const currentUser = (source: RequestSource) =>
		metaGetCurrentUserCapability.handler(
			{},
			{
				env: { APP_DB: db } as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					source,
					user: teamOrgUser,
				}),
			},
		)
	const memberEmail: RequestSource = {
		kind: 'inbound-email',
		sourceId: 'inbox-1',
		sender: {
			kind: 'member',
			actor: { userId: personIdFromStored(beaId), username: 'bea' },
			role: 'member',
		},
	}
	await expect(currentUser(memberEmail)).resolves.toMatchObject({
		user_id: beaId,
		email: 'bea@acme.example',
	})

	// A starter carried into another org has no role there: no email leaks.
	await expect(
		currentUser({
			kind: 'inherited',
			lineage: {
				actor: { userId: personIdFromStored(beaId), username: 'bea' },
				attribution: { kind: 'user', userId: personIdFromStored(beaId) },
				credential: {
					kind: 'session',
					id: 'session-1',
					orgId: ownerIdFromStored('c'.repeat(64)),
					scopes: null,
				},
				membership: { role: 'member' },
			},
		}),
	).resolves.toMatchObject({ user_id: teamOrgUser.userId, email: '' })

	await db
		.prepare(`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`)
		.bind('2026-10-11T00:00:00.000Z', beaId)
		.run()
	await expect(currentUser(memberEmail)).resolves.toMatchObject({
		user_id: teamOrgUser.userId,
		email: '',
	})
})
