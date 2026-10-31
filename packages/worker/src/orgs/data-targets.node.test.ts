import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	type UserScopedDataTarget,
} from '#worker/account/data-targets.ts'
import {
	hardPurgeDataTargets,
	hardPurgeOrgDataTargets,
	orgOwnedBucketChildSoftDeleteTables,
	orgOwnedUserIdSoftDeleteTables,
} from './data-targets.ts'

function sqlFor(target: UserScopedDataTarget) {
	const match = buildUserScopedTargetMatch({
		target,
		mcpUserId: ownerIdFromStored('org-1'),
		dbUserId: -1,
	})
	return buildUserScopedDeleteOrUpdateSql(match).sql
}

test('org hard purge is the org-owned slice of the account inventory plus the org graph', () => {
	const orgTargets = hardPurgeDataTargets('org')
	const kinds = new Set(orgTargets.map((target) => target.kind))
	expect(kinds.has('db_user_id')).toBe(false)
	expect(kinds.has('db_user_target')).toBe(false)
	expect(kinds.has('replace_user_column')).toBe(false)
	expect(
		orgTargets.some(
			(target) => 'table' in target && target.table === 'passkeys',
		),
	).toBe(false)

	const userIdTables = orgTargets
		.filter((target) => target.kind === 'user_id')
		.map((target) => target.table)
	for (const table of orgOwnedUserIdSoftDeleteTables) {
		if (table === 'email_notification_destinations') {
			expect(userIdTables).not.toContain(table)
			continue
		}
		expect(userIdTables).toContain(table)
	}
	// Owner-scoped inventory without deleted_at (#3121).
	expect(userIdTables).toContain('published_bundle_artifacts')
	expect(userIdTables).toContain('vector_embed_fingerprints')
	expect(userIdTables).toContain('saved_package_search_index_debt')
	expect(userIdTables).not.toContain('org_memberships')
	expect(userIdTables).not.toContain('org_invite_link_redemptions')

	for (const child of orgOwnedBucketChildSoftDeleteTables) {
		const childIndex = orgTargets.findIndex(
			(target) =>
				target.kind === 'bucket_parent' && target.table === child.child,
		)
		const parentIndex = orgTargets.findIndex(
			(target) => target.kind === 'user_id' && target.table === child.parent,
		)
		expect(childIndex).toBeGreaterThanOrEqual(0)
		expect(parentIndex).toBeGreaterThan(childIndex)
	}

	const listingChild = orgTargets.findIndex(
		(target) => target.kind === 'community_listing_child',
	)
	const listingParent = orgTargets.findIndex(
		(target) =>
			target.kind === 'user_columns' && target.table === 'community_listings',
	)
	expect(listingChild).toBeGreaterThanOrEqual(0)
	expect(listingParent).toBeGreaterThan(listingChild)

	const grantPermissions = orgTargets.findIndex(
		(target) =>
			target.kind === 'org_via_parent' && target.table === 'grant_permissions',
	)
	const grants = orgTargets.findIndex(
		(target) => target.kind === 'org_id' && target.table === 'grants',
	)
	expect(grantPermissions).toBeGreaterThanOrEqual(0)
	expect(grants).toBeGreaterThan(grantPermissions)
	expect(sqlFor(orgTargets[grants]!)).toBe(
		'DELETE FROM grants WHERE org_id = ?',
	)
	expect(
		orgTargets.some(
			(target) =>
				target.kind === 'org_id' && target.table === 'org_audit_outbox',
		),
	).toBe(true)
	expect(sqlFor(orgTargets[grantPermissions]!)).toContain(
		'SELECT id FROM grants WHERE org_id = ?',
	)
})

test('personal org hard purge is org-graph only so user purge retains inventory', () => {
	const personalTargets = hardPurgeOrgDataTargets('personal')
	expect(
		personalTargets.every(
			(target) => target.kind === 'org_id' || target.kind === 'org_via_parent',
		),
	).toBe(true)
	expect(
		personalTargets.some(
			(target) =>
				'table' in target && target.table === 'published_bundle_artifacts',
		),
	).toBe(false)
	expect(
		personalTargets.some(
			(target) => target.kind === 'org_id' && target.table === 'handles',
		),
	).toBe(true)
})
