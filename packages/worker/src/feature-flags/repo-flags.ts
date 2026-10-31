import {
	defaultFeatureFlagAudience,
	isFeatureFlagAudience,
} from '#universal/feature-flags/audiences.ts'
import {
	getFeatureFlagDefaultAudience,
	getFeatureFlagDefinition,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'
import { evaluateFlagState, type FeatureFlagEvaluation } from './service.ts'

/**
 * Repo-scoped flag evaluation. Same global row, audience, and per-user
 * overrides as user flags, plus a per-repo allowlist
 * (`feature_flag_repo_overrides`, keyed by `entity_sources.id`).
 *
 * Precedence:
 * 1. Repo override row (on or off) wins.
 * 2. Per-user override for the repo owner.
 * 3. Per-org row for the org that owns the repo (`entity_sources.user_id`
 *    when it is an org id, else the owner's personal org).
 * 4. Global row: off → off; on with `rollout_percent` → FNV-1a bucket of
 *    `key:sourceId`; on without a percentage → on.
 * 5. Registry default.
 * 6. Audience gate on the repo owner (skipped for overrides and org rows).
 */
export type RepoFeatureFlagSubject = {
	sourceId: string
	/** `entity_sources.user_id`: a person's stable id or personal org id. */
	ownerId: string
}

export type RepoFeatureFlagEvaluation = FeatureFlagEvaluation & {
	/** True when the per-repo allowlist row decided the value. */
	repoOverride: boolean
}

export type FeatureFlagRepoOverride = {
	sourceId: string
	enabled: boolean
	updatedByStableUserId: string | null
	updatedAt: string
}

async function readOwnerUser(
	db: D1Database,
	ownerId: string,
): Promise<{
	id: number
	experimentsOptIn: boolean
	personalOrgId: string | null
} | null> {
	const row = await db
		.prepare(
			`SELECT id, experiments_opt_in, personal_org_id FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)${andLiveDeletedAtSql()}
			 LIMIT 1`,
		)
		.bind(ownerId, ownerId)
		.first<{
			id: number
			experiments_opt_in: number
			personal_org_id: string | null
		}>()
	if (!row) return null
	return {
		id: row.id,
		experimentsOptIn: row.experiments_opt_in === 1,
		personalOrgId: row.personal_org_id,
	}
}

export async function evaluateRepoFeatureFlag(
	db: D1Database,
	key: FeatureFlagKey,
	subject: RepoFeatureFlagSubject,
): Promise<RepoFeatureFlagEvaluation> {
	const repoOverride = await db
		.prepare(
			`SELECT enabled FROM feature_flag_repo_overrides
			 WHERE flag_key = ? AND source_id = ?`,
		)
		.bind(key, subject.sourceId)
		.first<{ enabled: number }>()
	if (repoOverride) {
		return {
			enabled: repoOverride.enabled === 1,
			source: 'override',
			repoOverride: true,
		}
	}

	const owner = await readOwnerUser(db, subject.ownerId)
	const userOverride = owner
		? await db
				.prepare(
					`SELECT enabled FROM feature_flag_user_overrides
					 WHERE flag_key = ? AND user_id = ?`,
				)
				.bind(key, owner.id)
				.first<{ enabled: number }>()
		: null
	const repoOrgId = owner
		? (owner.personalOrgId ?? subject.ownerId)
		: subject.ownerId
	const orgRow = userOverride
		? null
		: await db
				.prepare(
					`SELECT f.enabled FROM feature_flag_org_overrides f
					 JOIN orgs o ON o.id = f.org_id${andActiveOrgSql('o')}
					 WHERE f.flag_key = ? AND f.org_id = ?`,
				)
				.bind(key, repoOrgId)
				.first<{ enabled: number }>()
	const global = await db
		.prepare(
			`SELECT enabled, rollout_percent, audience
			 FROM feature_flags
			 WHERE key = ?`,
		)
		.bind(key)
		.first<{
			enabled: number
			rollout_percent: number | null
			audience: string | null
		}>()

	const evaluation = evaluateFlagState({
		key,
		rolloutSubject: subject.sourceId,
		overrideEnabled: userOverride ? userOverride.enabled === 1 : null,
		orgEnabled: orgRow ? orgRow.enabled === 1 : null,
		global: global
			? {
					enabled: global.enabled === 1,
					rolloutPercent: global.rollout_percent,
					audience: isFeatureFlagAudience(global.audience)
						? global.audience
						: defaultFeatureFlagAudience,
				}
			: null,
		defaultEnabled: getFeatureFlagDefinition(key).defaultEnabled,
		defaultAudience: getFeatureFlagDefaultAudience(key),
		experimentsOptIn: owner?.experimentsOptIn ?? false,
	})
	return { ...evaluation, repoOverride: false }
}

export async function setFeatureFlagRepoOverride(
	db: D1Database,
	input: {
		key: FeatureFlagKey
		sourceId: string
		enabled: boolean
		updatedByStableUserId: string | null
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO feature_flag_repo_overrides
				(flag_key, source_id, enabled, updated_by, updated_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(flag_key, source_id) DO UPDATE SET
				enabled = excluded.enabled,
				updated_by = excluded.updated_by,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.key,
			input.sourceId,
			input.enabled ? 1 : 0,
			input.updatedByStableUserId,
		)
		.run()
}

export async function clearFeatureFlagRepoOverride(
	db: D1Database,
	input: { key: FeatureFlagKey; sourceId: string },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM feature_flag_repo_overrides
			 WHERE flag_key = ? AND source_id = ?`,
		)
		.bind(input.key, input.sourceId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listFeatureFlagRepoOverrides(
	db: D1Database,
	key: FeatureFlagKey,
): Promise<Array<FeatureFlagRepoOverride>> {
	const result = await db
		.prepare(
			`SELECT source_id, enabled, updated_by, updated_at
			 FROM feature_flag_repo_overrides
			 WHERE flag_key = ?
			 ORDER BY updated_at DESC, source_id ASC`,
		)
		.bind(key)
		.all<{
			source_id: string
			enabled: number
			updated_by: string | null
			updated_at: string
		}>()
	return (result.results ?? []).map((row) => ({
		sourceId: row.source_id,
		enabled: row.enabled === 1,
		updatedByStableUserId: row.updated_by,
		updatedAt: row.updated_at,
	}))
}
