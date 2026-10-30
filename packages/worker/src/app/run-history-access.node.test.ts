import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { canReadOrgRunHistory } from './run-history-access.ts'

async function setup() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureOrgsTestSchema(db)
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const orgSlug = `u${ownerId.slice(0, 8)}`
	await provisionPersonalOrg(db, { stableUserId: ownerId, username: orgSlug })
	const env = { APP_DB: db } as unknown as Env
	async function grant(input: {
		subjectId: string
		resourceType: 'org' | 'job'
		resourceId: string
		permissions: Array<string>
	}) {
		const now = new Date().toISOString()
		const grantId = crypto.randomUUID()
		await db
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					preset, created_by_user_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'user', ?, 'custom', ?, ?, ?)`,
			)
			.bind(
				grantId,
				ownerId,
				input.resourceType,
				input.resourceId,
				input.subjectId,
				ownerId,
				now,
				now,
			)
			.run()
		for (const permission of input.permissions) {
			await db
				.prepare(
					`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
				)
				.bind(grantId, permission)
				.run()
		}
		await db
			.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`)
			.bind(ownerId)
			.run()
	}
	function requestFor(userId: string, role: 'owner' | 'member' | 'billing') {
		return createMcpCallerContext({
			source: { kind: 'session' },
			baseUrl: 'https://kody.example',
			user: {
				userId: personIdFromStored(userId),
				email: `${userId}@example.com`,
				displayName: 'Person',
			},
			orgBinding: {
				org: { id: ownerIdFromStored(ownerId), slug: orgSlug },
				role,
			},
		}).request
	}
	return { env, ownerId, grant, requestFor }
}

test('Owners can read org run history; Members and Billing cannot by role', async () => {
	const { env, ownerId, requestFor } = await setup()
	const memberId = testStableUserIdFromEmail('member@example.com')
	await expect(
		canReadOrgRunHistory({ env, request: requestFor(ownerId, 'owner') }),
	).resolves.toBe(true)
	await expect(
		canReadOrgRunHistory({ env, request: requestFor(memberId, 'member') }),
	).resolves.toBe(false)
	await expect(
		canReadOrgRunHistory({ env, request: requestFor(memberId, 'billing') }),
	).resolves.toBe(false)
	await expect(canReadOrgRunHistory({ env, request: null })).resolves.toBe(
		false,
	)
})

test('an org job:read grant opens run history; a grant on one job does not', async () => {
	const { env, ownerId, grant, requestFor } = await setup()
	const memberId = testStableUserIdFromEmail('member@example.com')
	// Compiled access is memoized per request, so each check uses a new one.
	const request = () => requestFor(memberId, 'member')

	await grant({
		subjectId: memberId,
		resourceType: 'job',
		resourceId: 'job-1',
		permissions: ['job:read', 'job:execute'],
	})
	await expect(canReadOrgRunHistory({ env, request: request() })).resolves.toBe(
		false,
	)

	await grant({
		subjectId: memberId,
		resourceType: 'org',
		resourceId: ownerId,
		permissions: ['job:read'],
	})
	await expect(canReadOrgRunHistory({ env, request: request() })).resolves.toBe(
		true,
	)
})
