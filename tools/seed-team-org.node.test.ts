import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { seedStableUserIdFromEmail, seedTeamOrgIds } from './seed-sql.ts'
import { buildSeedSql } from './seed-test-data.ts'

const owner = 'owner@example.com'
const member = 'member@example.com'

function seed(db: DatabaseSync, plan?: 'free' | 'pro') {
	db.exec(
		buildSeedSql(
			[
				{
					email: owner,
					username: 'owner',
					passwordHash: 'h',
					admin: false,
					plan,
				},
				{ email: member, username: 'member', passwordHash: 'h', admin: false },
			],
			{
				teamOrg: { slug: 'seed-team', ownerEmail: owner, memberEmail: member },
			},
		),
	)
}

test('seed SQL builds a team org with an owner, a member, and a team on a migrated D1', () => {
	const db = new DatabaseSync(':memory:')
	applyAllMigrations(
		db,
		new URL('../packages/worker/migrations/', import.meta.url),
	)
	seed(db, 'pro')
	const { orgId, teamId } = seedTeamOrgIds('seed-team')
	const ownerId = seedStableUserIdFromEmail(owner)
	const memberId = seedStableUserIdFromEmail(member)

	expect(
		db
			.prepare(
				'SELECT user_id, role FROM org_memberships WHERE org_id = ? ORDER BY role DESC',
			)
			.all(orgId),
	).toEqual([
		{ user_id: ownerId, role: 'owner' },
		{ user_id: memberId, role: 'member' },
	])
	expect(
		db
			.prepare('SELECT user_id FROM team_members WHERE team_id = ?')
			.all(teamId),
	).toEqual([{ user_id: memberId }])
	expect(
		db.prepare('SELECT org_id FROM handles WHERE handle = ?').get('seed-team'),
	).toEqual({ org_id: orgId })
	expect(db.prepare('SELECT plan FROM orgs WHERE id = ?').get(ownerId)).toEqual(
		{ plan: 'pro' },
	)
	// The member is not in the owner's personal org.
	expect(
		db
			.prepare('SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?')
			.get(ownerId, memberId),
	).toBeUndefined()

	// Reseeding is idempotent, revives the member, and can drop back to free.
	db.prepare(
		'UPDATE org_memberships SET deleted_at = CURRENT_TIMESTAMP WHERE org_id = ? AND user_id = ?',
	).run(orgId, memberId)
	seed(db, 'free')
	expect(
		db
			.prepare(
				'SELECT deleted_at FROM org_memberships WHERE org_id = ? AND user_id = ?',
			)
			.get(orgId, memberId),
	).toEqual({ deleted_at: null })
	expect(db.prepare('SELECT plan FROM orgs WHERE id = ?').get(ownerId)).toEqual(
		{
			plan: 'free',
		},
	)
	expect(
		db.prepare('SELECT count(*) AS n FROM teams WHERE org_id = ?').get(orgId),
	).toEqual({ n: 1 })
})
