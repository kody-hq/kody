import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { repoPushQueueFlagKey } from '#universal/feature-flags/registry.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.unmock('#worker/audit-log.ts')
import {
	adminFeatureFlagRepoCheckCapability,
	adminFeatureFlagRepoOverrideCapability,
} from '#mcp/capabilities/admin/admin-feature-flag-repo-override.ts'
import {
	clearFeatureFlagRepoOverride,
	evaluateRepoFeatureFlag,
	listFeatureFlagRepoOverrides,
	setFeatureFlagRepoOverride,
} from './repo-flags.ts'

const key = repoPushQueueFlagKey
const ownerStableId = testStableUserIdFromEmail('owner@example.com')
const orgOwnedId = 'org_personal_distinct'

function createRepoFlagTest() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(
		readFileSync(
			new URL('../../audit-migrations/0001-audit-events.sql', import.meta.url),
			'utf8',
		),
	)
	const insertUser = sqlite.prepare(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
		 VALUES (?, ?, ?, 'hash', ?, ?)`,
	)
	insertUser.run(
		1,
		'admin',
		'admin@example.com',
		testStableUserIdFromEmail('admin@example.com'),
		testStableUserIdFromEmail('admin@example.com'),
	)
	insertUser.run(2, 'owner', 'owner@example.com', ownerStableId, orgOwnedId)
	const insertSource = sqlite.prepare(
		`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, manifest_path, source_root, created_at, updated_at)
		 VALUES (?, ?, 'repo', ?, ?, 'package.json', '.', '2026-01-01', '2026-01-01')`,
	)
	const insertRepo = sqlite.prepare(
		`INSERT INTO user_repos (id, user_id, name) VALUES (?, ?, ?)`,
	)
	const sources = Array.from({ length: 40 }, (_, index) => {
		const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
		insertRepo.run(`repo-${index}`, ownerStableId, `repo-${index}`)
		insertSource.run(id, ownerStableId, `repo-${index}`, `artifact-${index}`)
		return id
	})
	const db = createD1FromSqlite(sqlite)
	return { sqlite, db, sources }
}

function setGlobal(
	sqlite: DatabaseSync,
	input: { enabled: boolean; rolloutPercent: number | null; audience: string },
) {
	sqlite
		.prepare(
			`INSERT INTO feature_flags (key, enabled, rollout_percent, audience, note, updated_at)
			 VALUES (?, ?, ?, ?, '', CURRENT_TIMESTAMP)
			 ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled,
				rollout_percent = excluded.rollout_percent, audience = excluded.audience`,
		)
		.run(key, input.enabled ? 1 : 0, input.rolloutPercent, input.audience)
}

test('repo flag is off by default and the repo allowlist turns one repo on', async () => {
	const { db, sources } = createRepoFlagTest()
	const [target, other] = sources as [string, string]
	expect(
		await evaluateRepoFeatureFlag(db, key, {
			sourceId: target,
			ownerId: ownerStableId,
		}),
	).toEqual({ enabled: false, source: 'default', repoOverride: false })

	await setFeatureFlagRepoOverride(db, {
		key,
		sourceId: target,
		enabled: true,
		updatedByStableUserId: 'admin',
	})
	expect(
		await evaluateRepoFeatureFlag(db, key, {
			sourceId: target,
			ownerId: ownerStableId,
		}),
	).toEqual({ enabled: true, source: 'override', repoOverride: true })
	expect(
		(
			await evaluateRepoFeatureFlag(db, key, {
				sourceId: other,
				ownerId: ownerStableId,
			})
		).enabled,
	).toBe(false)
	expect(await listFeatureFlagRepoOverrides(db, key)).toEqual([
		expect.objectContaining({ sourceId: target, enabled: true }),
	])
	expect(
		await clearFeatureFlagRepoOverride(db, { key, sourceId: target }),
	).toBe(true)
	expect(await listFeatureFlagRepoOverrides(db, key)).toEqual([])
})

test('a repo off-override beats a global on and an owner override', async () => {
	const { sqlite, db, sources } = createRepoFlagTest()
	const target = sources[0]!
	setGlobal(sqlite, {
		enabled: true,
		rolloutPercent: null,
		audience: 'everyone',
	})
	sqlite
		.prepare(
			`INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled) VALUES (?, 2, 1)`,
		)
		.run(key)
	await setFeatureFlagRepoOverride(db, {
		key,
		sourceId: target,
		enabled: false,
		updatedByStableUserId: null,
	})
	expect(
		await evaluateRepoFeatureFlag(db, key, {
			sourceId: target,
			ownerId: ownerStableId,
		}),
	).toEqual({ enabled: false, source: 'override', repoOverride: true })
})

test('experiments audience gates on the repo owner, resolved by stable id or personal org id', async () => {
	const { sqlite, db, sources } = createRepoFlagTest()
	const target = sources[0]!
	setGlobal(sqlite, {
		enabled: true,
		rolloutPercent: null,
		audience: 'experiments_opt_in',
	})
	for (const ownerId of [ownerStableId, orgOwnedId]) {
		expect(
			(await evaluateRepoFeatureFlag(db, key, { sourceId: target, ownerId }))
				.enabled,
		).toBe(false)
	}
	sqlite.prepare(`UPDATE users SET experiments_opt_in = 1 WHERE id = 2`).run()
	for (const ownerId of [ownerStableId, orgOwnedId]) {
		expect(
			await evaluateRepoFeatureFlag(db, key, { sourceId: target, ownerId }),
		).toEqual({ enabled: true, source: 'global', repoOverride: false })
	}
	expect(
		(
			await evaluateRepoFeatureFlag(db, key, {
				sourceId: target,
				ownerId: 'team-org',
			})
		).enabled,
	).toBe(false)
})

test('percentage rollout buckets per repo, not per owner', async () => {
	const { sqlite, db, sources } = createRepoFlagTest()
	setGlobal(sqlite, { enabled: true, rolloutPercent: 50, audience: 'everyone' })
	const results = await Promise.all(
		sources.map(
			async (sourceId) =>
				(
					await evaluateRepoFeatureFlag(db, key, {
						sourceId,
						ownerId: ownerStableId,
					})
				).enabled,
		),
	)
	// Same owner, different repos: both buckets are represented.
	expect(results).toContain(true)
	expect(results).toContain(false)
	const again = await evaluateRepoFeatureFlag(db, key, {
		sourceId: sources[0]!,
		ownerId: ownerStableId,
	})
	expect(again.enabled).toBe(results[0])
	expect(again.source).toBe('rollout')
	setGlobal(sqlite, { enabled: true, rolloutPercent: 0, audience: 'everyone' })
	expect(
		(
			await evaluateRepoFeatureFlag(db, key, {
				sourceId: sources[0]!,
				ownerId: ownerStableId,
			})
		).enabled,
	).toBe(false)
})

test('admin repo override and check capabilities allowlist one repo and report its evaluation', async () => {
	const { db, sources } = createRepoFlagTest()
	const target = sources[0]!
	const ctx = {
		env: { APP_DB: db, AUDIT_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	}
	const before = await adminFeatureFlagRepoCheckCapability.handler(
		{ key, sourceId: target },
		ctx,
	)
	expect(before.evaluation.enabled).toBe(false)

	const set = await adminFeatureFlagRepoOverrideCapability.handler(
		{ key, sourceId: target, enabled: true },
		ctx,
	)
	expect(set.evaluation).toEqual({
		enabled: true,
		source: 'override',
		repoOverride: true,
	})
	expect(set.repoOverrides).toEqual([
		expect.objectContaining({
			sourceId: target,
			enabled: true,
			updatedByStableUserId: testStableUserIdFromEmail('admin@example.com'),
		}),
	])

	const after = await adminFeatureFlagRepoCheckCapability.handler(
		{ key, sourceId: target },
		ctx,
	)
	expect(after.evaluation.enabled).toBe(true)

	const byRepoId = await adminFeatureFlagRepoCheckCapability.handler(
		{ key, sourceId: 'repo-0' },
		ctx,
	)
	expect(byRepoId).toMatchObject({
		sourceId: target,
		repoId: 'repo-0',
		evaluation: { enabled: true },
	})

	await expect(
		adminFeatureFlagRepoOverrideCapability.handler(
			{ key, sourceId: '99999999-9999-4999-8999-999999999999', enabled: true },
			ctx,
		),
	).rejects.toThrow('No live repo source')
	const cleared = await adminFeatureFlagRepoOverrideCapability.handler(
		{ key, sourceId: target, clear: true },
		ctx,
	)
	expect(cleared.cleared).toBe(true)
	expect(cleared.evaluation.enabled).toBe(false)
})
