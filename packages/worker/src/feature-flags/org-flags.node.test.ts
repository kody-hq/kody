import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	evaluateRepoFeatureFlag,
	setFeatureFlagRepoOverride,
} from './repo-flags.ts'
import {
	clearFeatureFlagOrgOverride,
	evaluateFeatureFlag,
	getFeatureFlagEvaluationsForUser,
	listFeatureFlagsForAdmin,
	setFeatureFlagGlobalState,
	setFeatureFlagOrgOverride,
	setFeatureFlagUserOverride,
} from './service.ts'

const createdAt = '2026-10-20T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)

	async function insertUser(username: string, experimentsOptIn = false) {
		const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
		const result = sqlite
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id, experiments_opt_in, created_at, updated_at)
				 VALUES (?, ?, 'x', ?, ?, ?, ?, ?)`,
			)
			.run(
				username,
				`${username}@example.com`,
				stableUserId,
				stableUserId,
				experimentsOptIn ? 1 : 0,
				createdAt,
				createdAt,
			)
		await provisionPersonalOrg(db, {
			stableUserId,
			orgId: stableUserId,
			username,
			createdAt,
		})
		return { id: Number(result.lastInsertRowid), stableUserId }
	}

	function insertTeamOrg(id: string, slug: string) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, plan, created_at, updated_at)
				 VALUES (?, ?, ?, 'free', ?, ?)`,
			)
			.run(id, slug, `Team ${slug}`, createdAt, createdAt)
		return { orgId: id }
	}

	function addMember(orgId: string, stableUserId: string) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'member', ?)`,
			)
			.run(orgId, stableUserId, createdAt)
	}

	const admin = await insertUser('flag-admin')
	return { sqlite, db, insertUser, insertTeamOrg, addMember, admin }
}

test('org row applies only in that org context and only for live members', async () => {
	const { sqlite, db, insertUser, insertTeamOrg, addMember } = await setup()
	const member = await insertUser('member')
	const outsider = await insertUser('outsider')
	const { orgId } = insertTeamOrg('org-alpha', 'alpha')
	addMember(orgId, member.stableUserId)
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId,
		enabled: true,
		note: 'team pilot',
		updatedByStableUserId: null,
	})

	// Org on beats the registry default inside the org context.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', member.id, { orgId }),
	).resolves.toEqual({ enabled: true, source: 'org' })
	// No org context: org rows never apply, even for members.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', member.id),
	).resolves.toEqual({ enabled: false, source: 'default' })
	// Context org the caller is not a member of: ignored.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', outsider.id, { orgId }),
	).resolves.toEqual({ enabled: false, source: 'default' })
	// Anonymous callers never get org rows.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', null, { orgId }),
	).resolves.toEqual({ enabled: false, source: 'default' })

	// Removed membership and suspended orgs stop matching.
	sqlite
		.prepare(`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ?`)
		.run(createdAt, orgId)
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', member.id, { orgId }),
	).resolves.toEqual({ enabled: false, source: 'default' })
	sqlite
		.prepare(`UPDATE org_memberships SET deleted_at = NULL WHERE org_id = ?`)
		.run(orgId)
	sqlite
		.prepare(`UPDATE orgs SET suspended_at = ? WHERE id = ?`)
		.run(createdAt, orgId)
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', member.id, { orgId }),
	).resolves.toEqual({ enabled: false, source: 'default' })
})

test('multi-org users are evaluated against the request org only', async () => {
	const { db, insertUser, insertTeamOrg, addMember } = await setup()
	const user = await insertUser('multi')
	const alpha = insertTeamOrg('org-alpha', 'alpha')
	const beta = insertTeamOrg('org-beta', 'beta')
	const gamma = insertTeamOrg('org-gamma', 'gamma')
	for (const org of [alpha, beta, gamma])
		addMember(org.orgId, user.stableUserId)
	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		updatedBy: user.id,
	})
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId: alpha.orgId,
		enabled: true,
		updatedByStableUserId: null,
	})
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId: beta.orgId,
		enabled: false,
		updatedByStableUserId: null,
	})

	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', user.id, alpha),
	).resolves.toEqual({ enabled: true, source: 'org' })
	// Org off beats global on.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', user.id, beta),
	).resolves.toEqual({ enabled: false, source: 'org' })
	// An org with no row falls through to the global row.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', user.id, gamma),
	).resolves.toEqual({ enabled: true, source: 'global' })
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', user.id),
	).resolves.toEqual({ enabled: true, source: 'global' })

	// The bulk evaluator agrees with the single-key evaluator.
	const bulkBeta = await getFeatureFlagEvaluationsForUser(db, user.id, beta)
	expect(bulkBeta['demo-indicator']).toEqual({ enabled: false, source: 'org' })
	const bulkAlpha = await getFeatureFlagEvaluationsForUser(db, user.id, alpha)
	expect(bulkAlpha['demo-indicator']).toEqual({ enabled: true, source: 'org' })
	const bulkNone = await getFeatureFlagEvaluationsForUser(db, user.id)
	expect(bulkNone['demo-indicator']).toEqual({
		enabled: true,
		source: 'global',
	})
})

test('user overrides win over org rows in both directions', async () => {
	const { db, insertUser, insertTeamOrg, addMember, admin } = await setup()
	const forcedOff = await insertUser('forced-off')
	const forcedOn = await insertUser('forced-on')
	const on = insertTeamOrg('org-on', 'org-on')
	const off = insertTeamOrg('org-off', 'org-off')
	for (const user of [forcedOff, forcedOn]) {
		addMember(on.orgId, user.stableUserId)
		addMember(off.orgId, user.stableUserId)
	}
	for (const org of [
		{ ...on, enabled: true },
		{ ...off, enabled: false },
	]) {
		await setFeatureFlagOrgOverride(db, {
			key: 'demo-indicator',
			orgId: org.orgId,
			enabled: org.enabled,
			updatedByStableUserId: null,
		})
	}
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: forcedOff.id,
		enabled: false,
		updatedBy: admin.id,
	})
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: forcedOn.id,
		enabled: true,
		updatedBy: admin.id,
	})

	// Explicit user off beats org on.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', forcedOff.id, on),
	).resolves.toEqual({ enabled: false, source: 'override' })
	// Explicit user on beats org off.
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', forcedOn.id, off),
	).resolves.toEqual({ enabled: true, source: 'override' })
	const bulk = await getFeatureFlagEvaluationsForUser(db, forcedOff.id, on)
	expect(bulk['demo-indicator']).toEqual({ enabled: false, source: 'override' })
})

test('org on beats rollout 0 and the experiments audience gate', async () => {
	const { db, insertUser, insertTeamOrg, addMember, admin } = await setup()
	const member = await insertUser('not-opted-in')
	const nonMember = await insertUser('also-not-opted-in')
	const { orgId } = insertTeamOrg('org-alpha', 'alpha')
	addMember(orgId, member.stableUserId)
	await setFeatureFlagGlobalState(db, {
		key: 'execution-contexts',
		enabled: true,
		rolloutPercent: 0,
		audience: 'experiments_opt_in',
		updatedBy: admin.id,
	})
	await setFeatureFlagOrgOverride(db, {
		key: 'execution-contexts',
		orgId,
		enabled: true,
		updatedByStableUserId: null,
	})

	await expect(
		evaluateFeatureFlag(db, 'execution-contexts', member.id, { orgId }),
	).resolves.toEqual({ enabled: true, source: 'org' })
	await expect(
		evaluateFeatureFlag(db, 'execution-contexts', nonMember.id, { orgId }),
	).resolves.toMatchObject({ enabled: false })
	await expect(
		evaluateFeatureFlag(db, 'execution-contexts', member.id),
	).resolves.toMatchObject({ enabled: false })
})

test('personal org rows apply to the owner in their personal context', async () => {
	const { db, insertUser } = await setup()
	const user = await insertUser('solo')
	const other = await insertUser('other')
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId: user.stableUserId,
		enabled: true,
		updatedByStableUserId: null,
	})
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', user.id, {
			orgId: user.stableUserId,
		}),
	).resolves.toEqual({ enabled: true, source: 'org' })
	await expect(
		evaluateFeatureFlag(db, 'demo-indicator', other.id, {
			orgId: user.stableUserId,
		}),
	).resolves.toEqual({ enabled: false, source: 'default' })
})

test('repo flags: repo row > owner user override > owning org row > global', async () => {
	const { db, insertUser, insertTeamOrg, admin } = await setup()
	const owner = await insertUser('repo-owner')
	const team = insertTeamOrg('org-team', 'team')
	await setFeatureFlagGlobalState(db, {
		key: 'repo-push-queue',
		enabled: false,
		rolloutPercent: null,
		audience: 'everyone',
		updatedBy: admin.id,
	})
	const teamRepo = { sourceId: 'source-team', ownerId: team.orgId }
	const personalRepo = {
		sourceId: 'source-personal',
		ownerId: owner.stableUserId,
	}

	await expect(
		evaluateRepoFeatureFlag(db, 'repo-push-queue', teamRepo),
	).resolves.toMatchObject({ enabled: false, source: 'global' })

	await setFeatureFlagOrgOverride(db, {
		key: 'repo-push-queue',
		orgId: team.orgId,
		enabled: true,
		updatedByStableUserId: null,
	})
	await expect(
		evaluateRepoFeatureFlag(db, 'repo-push-queue', teamRepo),
	).resolves.toEqual({ enabled: true, source: 'org', repoOverride: false })

	await setFeatureFlagRepoOverride(db, {
		key: 'repo-push-queue',
		sourceId: teamRepo.sourceId,
		enabled: false,
		updatedByStableUserId: null,
	})
	await expect(
		evaluateRepoFeatureFlag(db, 'repo-push-queue', teamRepo),
	).resolves.toEqual({ enabled: false, source: 'override', repoOverride: true })

	// Personal repos: the personal org row applies, the owner override wins.
	await setFeatureFlagOrgOverride(db, {
		key: 'repo-push-queue',
		orgId: owner.stableUserId,
		enabled: true,
		updatedByStableUserId: null,
	})
	await expect(
		evaluateRepoFeatureFlag(db, 'repo-push-queue', personalRepo),
	).resolves.toEqual({ enabled: true, source: 'org', repoOverride: false })
	await setFeatureFlagUserOverride(db, {
		key: 'repo-push-queue',
		userId: owner.id,
		enabled: false,
		updatedBy: admin.id,
	})
	await expect(
		evaluateRepoFeatureFlag(db, 'repo-push-queue', personalRepo),
	).resolves.toEqual({
		enabled: false,
		source: 'override',
		repoOverride: false,
	})
})

test('admin list shows audited org rows; clearing leaves user overrides untouched', async () => {
	const { db, insertUser, insertTeamOrg, addMember, admin } = await setup()
	const member = await insertUser('listed-member')
	const { orgId } = insertTeamOrg('org-alpha', 'alpha')
	addMember(orgId, member.stableUserId)
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: member.id,
		enabled: true,
		updatedBy: admin.id,
	})
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId,
		enabled: false,
		note: 'pilot paused',
		updatedByStableUserId: admin.stableUserId,
	})
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId: member.stableUserId,
		enabled: true,
		updatedByStableUserId: admin.stableUserId,
	})

	const listed = await listFeatureFlagsForAdmin(db)
	const flag = listed.find((entry) => entry.key === 'demo-indicator')
	expect(flag?.orgOverrides).toEqual([
		expect.objectContaining({
			orgId,
			slug: 'alpha',
			displayName: 'Team alpha',
			personal: false,
			enabled: false,
			note: 'pilot paused',
			updatedByStableUserId: admin.stableUserId,
		}),
		expect.objectContaining({
			orgId: member.stableUserId,
			slug: 'listed-member',
			personal: true,
			enabled: true,
			note: '',
		}),
	])
	expect(listed.every((entry) => Array.isArray(entry.orgOverrides))).toBe(true)

	// Updating without a note keeps the existing note.
	await setFeatureFlagOrgOverride(db, {
		key: 'demo-indicator',
		orgId,
		enabled: true,
		updatedByStableUserId: admin.stableUserId,
	})
	const updated = (await listFeatureFlagsForAdmin(db))
		.find((entry) => entry.key === 'demo-indicator')
		?.orgOverrides.find((row) => row.orgId === orgId)
	expect(updated).toMatchObject({ enabled: true, note: 'pilot paused' })

	await expect(
		clearFeatureFlagOrgOverride(db, { key: 'demo-indicator', orgId }),
	).resolves.toBe(true)
	await expect(
		clearFeatureFlagOrgOverride(db, { key: 'demo-indicator', orgId }),
	).resolves.toBe(false)
	const after = (await listFeatureFlagsForAdmin(db)).find(
		(entry) => entry.key === 'demo-indicator',
	)
	expect(after?.orgOverrides.map((row) => row.orgId)).toEqual([
		member.stableUserId,
	])
	expect(after?.overrides).toEqual([
		expect.objectContaining({
			stableUserId: member.stableUserId,
			enabled: true,
		}),
	])
})
