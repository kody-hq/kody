import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createOrg } from '#worker/orgs/access-writes.ts'
import { updateOrgSessionAnalytics } from '#worker/session-analytics/consent.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { deriveWaitingItems } from './derive-waiting.ts'

const createdAt = '2026-11-01T00:00:00.000Z'

async function choiceItems(
	env: Env,
	input: { orgId: string; orgSlug: string; personId: string },
) {
	const items = await deriveWaitingItems({
		env,
		user: {
			userId: 1,
			stableUserId: ownerIdFromStored(input.orgId),
			actorStableUserId: ownerIdFromStored(input.personId),
			email: 'person@example.com',
			username: 'person',
			emailVerified: true,
		},
		orgSlug: input.orgSlug,
	})
	return items.filter((item) => item.kind === 'session-analytics-choice')
}

test('every org that has not answered asks its Owners and Admins once, from creation, until they answer', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: createMemoryKvNamespace().kv,
	} as unknown as Env
	const audit = createTestOrgAuditWriter()

	// An org that existed before session analytics shipped: no stored choice.
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at) VALUES ('org-old', 'old-org', 'free', ?, ?)`,
		)
		.run(createdAt, createdAt)
	const addMember = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
	)
	addMember.run('org-old', 'person-admin', 'admin', createdAt)
	addMember.run('org-old', 'person-member', 'member', createdAt)
	const oldOrg = { orgId: 'org-old', orgSlug: 'old-org' }

	const asked = await choiceItems(env, { ...oldOrg, personId: 'person-admin' })
	expect(asked).toHaveLength(1)
	expect(asked[0]).toMatchObject({
		id: 'session-analytics-choice',
		href: '/@old-org/-/settings#session-analytics',
	})
	// Reading again never adds a second item: the item is the org's state.
	expect(
		await choiceItems(env, { ...oldOrg, personId: 'person-admin' }),
	).toEqual(asked)
	expect(
		await choiceItems(env, { ...oldOrg, personId: 'person-member' }),
	).toEqual([])

	// A newly created org asks its creator right away, with collection off.
	const created = await createOrg({
		db,
		env,
		slug: 'new-team',
		createdByUserId: 'person-owner',
		audit,
	})
	const newOrg = { orgId: created.id, orgSlug: created.slug }
	expect(
		sqlite
			.prepare(`SELECT session_analytics FROM orgs WHERE id = ?`)
			.get(created.id),
	).toEqual({ session_analytics: 'unset' })
	expect(
		await choiceItems(env, { ...newOrg, personId: 'person-owner' }),
	).toHaveLength(1)

	for (const [org, enabled] of [
		[oldOrg, true],
		[newOrg, false],
	] as const) {
		await updateOrgSessionAnalytics(db, {
			orgId: org.orgId,
			enabled,
			audit,
		})
	}
	expect(
		await choiceItems(env, { ...oldOrg, personId: 'person-admin' }),
	).toEqual([])
	expect(
		await choiceItems(env, { ...newOrg, personId: 'person-owner' }),
	).toEqual([])
})
