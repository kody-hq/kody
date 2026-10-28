import { fnv1a32 } from '@kody-internal/shared/fnv1a.ts'
import {
	defaultFeatureFlagAudience,
	isFeatureFlagAudience,
	type FeatureFlagAudience,
} from '#universal/feature-flags/audiences.ts'
import {
	featureFlagDefinitions,
	featureFlagKeys,
	getFeatureFlagDefaultAudience,
	getFeatureFlagDefinition,
	isFeatureFlagKey,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import { type AdminFeatureFlag } from '#universal/feature-flags/types.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'

export type { AdminFeatureFlag } from '#universal/feature-flags/types.ts'
export type { FeatureFlagAudience } from '#universal/feature-flags/audiences.ts'

const maxFeatureFlagNoteLength = 500

type GlobalFlagRow = {
	key: string
	enabled: number
	rollout_percent: number | null
	audience: string
	note: string
	updated_by_stable_user_id: string | null
	updated_at: string
}

type OverrideFlagRow = {
	flag_key: string
	user_id: number
	enabled: number
	updated_at: string
	username: string
	stable_user_id: string
}

type OverrideEnabledRow = {
	flag_key: string
	enabled: number
}

/**
 * Deterministic 0–99 bucket for percentage rollouts.
 */
function computeRolloutBucket(key: string, subject: number | string): number {
	return fnv1a32(`${key}:${subject}`) % 100
}

/**
 * How a flag's evaluated value was assigned. Recorded with success-metric
 * exposures so readouts can compare only fairly assigned cohorts: `override`
 * users are hand-picked (selection bias) and are excluded from on/off
 * comparisons, while `rollout` users are deterministically bucketed. `org`
 * users got the value from a per-org row (hand-picked team) and are likewise
 * excluded from on/off and aggregated into their own cohort.
 */
export type FeatureFlagAssignmentSource =
	| 'override'
	| 'org'
	| 'global'
	| 'rollout'
	| 'default'

export type FeatureFlagEvaluation = {
	enabled: boolean
	source: FeatureFlagAssignmentSource
}

function normalizeAudience(
	value: string | null | undefined,
): FeatureFlagAudience {
	if (isFeatureFlagAudience(value)) return value
	return defaultFeatureFlagAudience
}

/**
 * After override / global / rollout / default, optionally require the account
 * Experiments opt-in. Overrides skip this gate so operators can still dogfood
 * a specific account without that user visiting `/account/experiments`, and
 * so do org rows: turning a flag on for a team reaches every member.
 */
function applyAudienceGate(input: {
	evaluation: FeatureFlagEvaluation
	audience: FeatureFlagAudience
	experimentsOptIn: boolean
}): FeatureFlagEvaluation {
	if (input.evaluation.source === 'override') return input.evaluation
	if (input.evaluation.source === 'org') return input.evaluation
	if (!input.evaluation.enabled) return input.evaluation
	switch (input.audience) {
		case 'everyone':
			return input.evaluation
		case 'experiments_opt_in':
			if (input.experimentsOptIn) return input.evaluation
			return { enabled: false, source: input.evaluation.source }
		default: {
			const exhaustive: never = input.audience
			return exhaustive
		}
	}
}

export function evaluateFlagState(input: {
	key: string
	/** User id for user flags, source id for repo flags; null skips rollout. */
	rolloutSubject: number | string | null
	overrideEnabled: boolean | null
	/**
	 * Per-org row for the evaluation's org context (already filtered to an org
	 * the subject belongs to). Omitted or null when there is no org context or
	 * no row.
	 */
	orgEnabled?: boolean | null
	global: {
		enabled: boolean
		rolloutPercent: number | null
		audience: FeatureFlagAudience
	} | null
	defaultEnabled: boolean
	defaultAudience: FeatureFlagAudience
	experimentsOptIn: boolean
}): FeatureFlagEvaluation {
	const audience = input.global?.audience ?? input.defaultAudience
	if (input.overrideEnabled !== null) {
		return applyAudienceGate({
			evaluation: { enabled: input.overrideEnabled, source: 'override' },
			audience,
			experimentsOptIn: input.experimentsOptIn,
		})
	}
	if (input.orgEnabled !== undefined && input.orgEnabled !== null) {
		return { enabled: input.orgEnabled, source: 'org' }
	}
	if (input.global) {
		if (!input.global.enabled) {
			return applyAudienceGate({
				evaluation: { enabled: false, source: 'global' },
				audience,
				experimentsOptIn: input.experimentsOptIn,
			})
		}
		if (input.global.rolloutPercent === null) {
			return applyAudienceGate({
				evaluation: { enabled: true, source: 'global' },
				audience,
				experimentsOptIn: input.experimentsOptIn,
			})
		}
		if (input.rolloutSubject === null) {
			return applyAudienceGate({
				evaluation: { enabled: false, source: 'rollout' },
				audience,
				experimentsOptIn: input.experimentsOptIn,
			})
		}
		return applyAudienceGate({
			evaluation: {
				enabled:
					computeRolloutBucket(input.key, input.rolloutSubject) <
					input.global.rolloutPercent,
				source: 'rollout',
			},
			audience,
			experimentsOptIn: input.experimentsOptIn,
		})
	}
	return applyAudienceGate({
		evaluation: { enabled: input.defaultEnabled, source: 'default' },
		audience,
		experimentsOptIn: input.experimentsOptIn,
	})
}

function assertValidRolloutPercent(rolloutPercent: number | null) {
	if (rolloutPercent === null) return
	if (
		!Number.isInteger(rolloutPercent) ||
		rolloutPercent < 0 ||
		rolloutPercent > 100
	) {
		throw new Error('rolloutPercent must be an integer between 0 and 100.')
	}
}

function normalizeFeatureFlagNote(note: unknown): string | null {
	if (note === undefined) {
		return null
	}
	if (typeof note !== 'string') {
		throw new Error('note must be a string.')
	}
	const trimmed = note.trim()
	if (trimmed.length > maxFeatureFlagNoteLength) {
		throw new Error(
			`note must be at most ${maxFeatureFlagNoteLength} characters.`,
		)
	}
	return trimmed
}

/**
 * null = leave unchanged on update (default `everyone` on first insert).
 */
function normalizeFeatureFlagAudience(
	audience: unknown,
): FeatureFlagAudience | null {
	if (audience === undefined) {
		return null
	}
	if (!isFeatureFlagAudience(audience)) {
		throw new Error('audience must be one of: everyone, experiments_opt_in.')
	}
	return audience
}

export async function readExperimentsOptInForUser(
	db: D1Database,
	userId: number | null,
): Promise<boolean> {
	if (userId === null) return false
	const row = await db
		.prepare(
			`SELECT experiments_opt_in FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{ experiments_opt_in: number }>()
	return row?.experiments_opt_in === 1
}

/**
 * Org context for flag evaluation: the org that owns the request or run (the
 * package, execute, or page being used). Null means no org context, and then
 * no org row applies. A user in several orgs is never evaluated against "any
 * of my orgs"; only the context org counts, and only while they are a live
 * member of it (or it is their personal org).
 */
export type FeatureFlagOrgContext = { orgId: string } | null

function orgOverrideStatement(
	db: D1Database,
	input: { userId: number; orgId: string; key?: FeatureFlagKey },
) {
	return db
		.prepare(
			`SELECT f.flag_key, f.enabled
			 FROM feature_flag_org_overrides f
			 JOIN users u ON u.id = ?${andLiveDeletedAtSql('u')}
			 JOIN orgs o ON o.id = f.org_id${andActiveOrgSql('o')}
			 WHERE f.org_id = ?${input.key ? ' AND f.flag_key = ?' : ''}
			 AND (
				u.personal_org_id = f.org_id
				OR EXISTS (
					SELECT 1 FROM org_memberships m
					WHERE m.org_id = f.org_id
						AND m.user_id = u.stable_user_id${andLiveDeletedAtSql('m')}
				)
			 )`,
		)
		.bind(
			...(input.key
				? [input.userId, input.orgId, input.key]
				: [input.userId, input.orgId]),
		)
}

export async function evaluateFeatureFlag(
	db: D1Database,
	key: FeatureFlagKey,
	userId: number | null,
	orgContext: FeatureFlagOrgContext = null,
): Promise<FeatureFlagEvaluation> {
	const experimentsOptIn = await readExperimentsOptInForUser(db, userId)

	if (userId !== null) {
		const override = await db
			.prepare(
				`SELECT enabled
				 FROM feature_flag_user_overrides
				 WHERE flag_key = ? AND user_id = ?`,
			)
			.bind(key, userId)
			.first<{ enabled: number }>()
		if (override) {
			return applyAudienceGate({
				evaluation: {
					enabled: override.enabled === 1,
					source: 'override',
				},
				// Overrides skip the audience gate; audience value is unused.
				audience: defaultFeatureFlagAudience,
				experimentsOptIn,
			})
		}
	}

	if (userId !== null && orgContext) {
		const orgRow = await orgOverrideStatement(db, {
			userId,
			orgId: orgContext.orgId,
			key,
		}).first<OverrideEnabledRow>()
		if (orgRow) return { enabled: orgRow.enabled === 1, source: 'org' }
	}

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

	return evaluateFlagState({
		key,
		rolloutSubject: userId,
		overrideEnabled: null,
		global: global
			? {
					enabled: global.enabled === 1,
					rolloutPercent: global.rollout_percent,
					audience: normalizeAudience(global.audience),
				}
			: null,
		defaultEnabled: getFeatureFlagDefinition(key).defaultEnabled,
		defaultAudience: getFeatureFlagDefaultAudience(key),
		experimentsOptIn,
	})
}

export async function isFeatureEnabled(
	db: D1Database,
	key: FeatureFlagKey,
	userId: number | null,
	orgContext: FeatureFlagOrgContext = null,
): Promise<boolean> {
	return (await evaluateFeatureFlag(db, key, userId, orgContext)).enabled
}

/**
 * Global on/off only. A percentage rollout is still globally on: in-bucket
 * users and per-user overrides are decided by {@link isFeatureEnabled}.
 */
export async function isFeatureGloballyEnabled(
	db: D1Database,
	key: FeatureFlagKey,
): Promise<boolean> {
	const global = await db
		.prepare(
			`SELECT enabled
			 FROM feature_flags
			 WHERE key = ?`,
		)
		.bind(key)
		.first<{ enabled: number }>()
	if (!global) return getFeatureFlagDefinition(key).defaultEnabled
	return global.enabled === 1
}

type GlobalEvaluationRow = {
	key: string
	enabled: number
	rollout_percent: number | null
	audience: string | null
}

function d1ResultRows<T>(result: D1Result<T> | undefined): Array<T> {
	return result?.results ?? []
}

export async function getFeatureFlagEvaluationsForUser(
	db: D1Database,
	userId: number | null,
	orgContext: FeatureFlagOrgContext = null,
): Promise<Record<FeatureFlagKey, FeatureFlagEvaluation>> {
	const globalStatement = db.prepare(
		`SELECT key, enabled, rollout_percent, audience
			 FROM feature_flags`,
	)
	let globalRows: Array<GlobalEvaluationRow>
	let overrideRows: Array<OverrideEnabledRow> = []
	let orgRows: Array<OverrideEnabledRow> = []
	let experimentsOptIn = false
	if (userId === null) {
		const globalResult = await globalStatement.all<GlobalEvaluationRow>()
		globalRows = globalResult.results ?? []
	} else {
		const [globalResult, overrideResult, optInResult, orgResult] =
			await db.batch([
				globalStatement,
				db
					.prepare(
						`SELECT flag_key, enabled
				 FROM feature_flag_user_overrides
				 WHERE user_id = ?`,
					)
					.bind(userId),
				db
					.prepare(
						`SELECT experiments_opt_in FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
					)
					.bind(userId),
				...(orgContext
					? [orgOverrideStatement(db, { userId, orgId: orgContext.orgId })]
					: []),
			])
		orgRows = d1ResultRows<OverrideEnabledRow>(
			orgResult as D1Result<OverrideEnabledRow> | undefined,
		)
		globalRows = d1ResultRows<GlobalEvaluationRow>(
			globalResult as D1Result<GlobalEvaluationRow>,
		)
		overrideRows = d1ResultRows<OverrideEnabledRow>(
			overrideResult as D1Result<OverrideEnabledRow>,
		)
		const optInRows = d1ResultRows<{ experiments_opt_in: number }>(
			optInResult as D1Result<{ experiments_opt_in: number }>,
		)
		experimentsOptIn = optInRows[0]?.experiments_opt_in === 1
	}
	const globalByKey = new Map(globalRows.map((row) => [row.key, row]))

	const overrideByKey = new Map<string, boolean>()
	for (const row of overrideRows) {
		overrideByKey.set(row.flag_key, row.enabled === 1)
	}

	const orgByKey = new Map<string, boolean>()
	for (const row of orgRows) {
		orgByKey.set(row.flag_key, row.enabled === 1)
	}

	const evaluations = {} as Record<FeatureFlagKey, FeatureFlagEvaluation>
	for (const key of featureFlagKeys) {
		const global = globalByKey.get(key)
		const overrideEnabled = overrideByKey.has(key)
			? (overrideByKey.get(key) ?? false)
			: null
		evaluations[key] = evaluateFlagState({
			key,
			rolloutSubject: userId,
			overrideEnabled,
			orgEnabled: orgByKey.get(key) ?? null,
			global: global
				? {
						enabled: global.enabled === 1,
						rolloutPercent: global.rollout_percent,
						audience: normalizeAudience(global.audience),
					}
				: null,
			defaultEnabled: getFeatureFlagDefinition(key).defaultEnabled,
			defaultAudience: getFeatureFlagDefaultAudience(key),
			experimentsOptIn,
		})
	}
	return evaluations
}

export async function getFeatureFlagsForUser(
	db: D1Database,
	userId: number | null,
	orgContext: FeatureFlagOrgContext = null,
): Promise<Record<FeatureFlagKey, boolean>> {
	const evaluations = await getFeatureFlagEvaluationsForUser(
		db,
		userId,
		orgContext,
	)
	const flags = {} as Record<FeatureFlagKey, boolean>
	for (const key of featureFlagKeys) {
		flags[key] = evaluations[key].enabled
	}
	return flags
}

export async function setFeatureFlagGlobalState(
	db: D1Database,
	input: {
		key: FeatureFlagKey
		enabled: boolean
		rolloutPercent: number | null
		audience?: unknown
		note?: unknown
		updatedBy: number
	},
): Promise<void> {
	assertValidRolloutPercent(input.rolloutPercent)
	// null note/audience = "leave unchanged" on update (defaults on first insert);
	// callers omit the field to preserve an existing operator value.
	const note = normalizeFeatureFlagNote(input.note)
	const audience = normalizeFeatureFlagAudience(input.audience)
	const insertAudience = audience ?? getFeatureFlagDefaultAudience(input.key)
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled, rollout_percent, note, audience, updated_by, updated_at)
			 VALUES (?, ?, ?, COALESCE(?, ''), ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(key) DO UPDATE SET
				enabled = excluded.enabled,
				rollout_percent = excluded.rollout_percent,
				note = COALESCE(?, feature_flags.note),
				audience = COALESCE(?, feature_flags.audience),
				updated_by = excluded.updated_by,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.key,
			input.enabled ? 1 : 0,
			input.rolloutPercent,
			note,
			insertAudience,
			input.updatedBy,
			note,
			audience,
		)
		.run()
}

const featureFlagUserOverrideUpsertSql = `INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled, updated_by, updated_at)
			 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(flag_key, user_id) DO UPDATE SET
				enabled = excluded.enabled,
				updated_by = excluded.updated_by,
				updated_at = CURRENT_TIMESTAMP`

export async function setFeatureFlagUserOverride(
	db: D1Database,
	input: {
		key: FeatureFlagKey
		userId: number
		enabled: boolean
		updatedBy: number
	},
): Promise<void> {
	await db
		.prepare(featureFlagUserOverrideUpsertSql)
		.bind(input.key, input.userId, input.enabled ? 1 : 0, input.updatedBy)
		.run()
}

/**
 * Apply several per-user overrides in one D1 batch so related opt-ins commit
 * together or not at all.
 */
export async function setFeatureFlagUserOverrides(
	db: D1Database,
	overrides: ReadonlyArray<{
		key: FeatureFlagKey
		userId: number
		enabled: boolean
		updatedBy: number
	}>,
): Promise<void> {
	if (overrides.length === 0) return
	if (overrides.length === 1) {
		const [only] = overrides
		if (!only) return
		await setFeatureFlagUserOverride(db, only)
		return
	}
	await db.batch(
		overrides.map((override) =>
			db
				.prepare(featureFlagUserOverrideUpsertSql)
				.bind(
					override.key,
					override.userId,
					override.enabled ? 1 : 0,
					override.updatedBy,
				),
		),
	)
}

export async function clearFeatureFlagUserOverride(
	db: D1Database,
	input: { key: FeatureFlagKey; userId: number },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM feature_flag_user_overrides
			 WHERE flag_key = ? AND user_id = ?`,
		)
		.bind(input.key, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function setFeatureFlagOrgOverride(
	db: D1Database,
	input: {
		key: FeatureFlagKey
		orgId: string
		enabled: boolean
		note?: unknown
		updatedByStableUserId: string | null
	},
): Promise<void> {
	// null note = "leave unchanged" on update, like the global row.
	const note = normalizeFeatureFlagNote(input.note)
	await db
		.prepare(
			`INSERT INTO feature_flag_org_overrides
				(flag_key, org_id, enabled, note, updated_by, updated_at)
			 VALUES (?, ?, ?, COALESCE(?, ''), ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(flag_key, org_id) DO UPDATE SET
				enabled = excluded.enabled,
				note = COALESCE(?, feature_flag_org_overrides.note),
				updated_by = excluded.updated_by,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.key,
			input.orgId,
			input.enabled ? 1 : 0,
			note,
			input.updatedByStableUserId,
			note,
		)
		.run()
}

export async function clearFeatureFlagOrgOverride(
	db: D1Database,
	input: { key: FeatureFlagKey; orgId: string },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM feature_flag_org_overrides
			 WHERE flag_key = ? AND org_id = ?`,
		)
		.bind(input.key, input.orgId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

type OrgOverrideFlagRow = {
	flag_key: string
	org_id: string
	slug: string
	display_name: string | null
	personal: number
	enabled: number
	note: string
	updated_by: string | null
	updated_at: string
}

export async function listFeatureFlagsForAdmin(
	db: D1Database,
): Promise<Array<AdminFeatureFlag>> {
	const globalResult = await db
		.prepare(
			`SELECT f.key, f.enabled, f.rollout_percent, f.audience, f.note,
				u.stable_user_id AS updated_by_stable_user_id, f.updated_at
			 FROM feature_flags f
			 LEFT JOIN users u ON u.id = f.updated_by AND u.deleted_at IS NULL`,
		)
		.all<GlobalFlagRow>()
	const globalByKey = new Map(
		(globalResult.results ?? []).map((row) => [row.key, row]),
	)

	const overrideResult = await db
		.prepare(
			`SELECT o.flag_key, o.user_id, o.enabled, o.updated_at, u.username,
				u.stable_user_id
			 FROM feature_flag_user_overrides o
			 JOIN users u ON u.id = o.user_id
			 WHERE u.deleted_at IS NULL
			 ORDER BY o.flag_key ASC, u.username ASC`,
		)
		.all<OverrideFlagRow>()
	const overridesByKey = new Map<
		string,
		Array<AdminFeatureFlag['overrides'][number]>
	>()
	for (const row of overrideResult.results ?? []) {
		const list = overridesByKey.get(row.flag_key) ?? []
		list.push({
			stableUserId: row.stable_user_id,
			username: row.username,
			enabled: row.enabled === 1,
			updatedAt: row.updated_at,
		})
		overridesByKey.set(row.flag_key, list)
	}

	const orgOverrideResult = await db
		.prepare(
			`SELECT f.flag_key, f.org_id, o.slug, o.display_name,
				EXISTS (
					SELECT 1 FROM users pu WHERE pu.personal_org_id = o.id
				) AS personal,
				f.enabled, f.note, f.updated_by, f.updated_at
			 FROM feature_flag_org_overrides f
			 JOIN orgs o ON o.id = f.org_id${andLiveDeletedAtSql('o')}
			 ORDER BY f.flag_key ASC, o.slug ASC`,
		)
		.all<OrgOverrideFlagRow>()
	const orgOverridesByKey = new Map<
		string,
		Array<AdminFeatureFlag['orgOverrides'][number]>
	>()
	for (const row of orgOverrideResult.results ?? []) {
		const list = orgOverridesByKey.get(row.flag_key) ?? []
		list.push({
			orgId: row.org_id,
			slug: row.slug,
			displayName: row.display_name,
			personal: row.personal === 1,
			enabled: row.enabled === 1,
			note: row.note,
			updatedByStableUserId: row.updated_by,
			updatedAt: row.updated_at,
		})
		orgOverridesByKey.set(row.flag_key, list)
	}

	const repoOverrideKeyResult = await db
		.prepare(`SELECT DISTINCT flag_key FROM feature_flag_repo_overrides`)
		.all<{ flag_key: string }>()

	const flags: Array<AdminFeatureFlag> = []
	const seenKeys = new Set<string>()

	for (const definition of featureFlagDefinitions) {
		seenKeys.add(definition.key)
		const global = globalByKey.get(definition.key)
		flags.push({
			key: definition.key,
			description: definition.description,
			defaultEnabled: definition.defaultEnabled,
			defaultAudience: getFeatureFlagDefaultAudience(definition.key),
			stale: false,
			successMetric:
				getFeatureFlagDefinition(definition.key).successMetric ?? null,
			global: global
				? {
						enabled: global.enabled === 1,
						rolloutPercent: global.rollout_percent,
						audience: normalizeAudience(global.audience),
						note: global.note,
						updatedByStableUserId: global.updated_by_stable_user_id,
						updatedAt: global.updated_at,
					}
				: null,
			overrides: overridesByKey.get(definition.key) ?? [],
			orgOverrides: orgOverridesByKey.get(definition.key) ?? [],
		})
	}

	const staleKeys = new Set<string>()
	for (const key of globalByKey.keys()) {
		if (!seenKeys.has(key)) staleKeys.add(key)
	}
	for (const key of overridesByKey.keys()) {
		if (!seenKeys.has(key)) staleKeys.add(key)
	}
	for (const key of orgOverridesByKey.keys()) {
		if (!seenKeys.has(key)) staleKeys.add(key)
	}
	for (const row of repoOverrideKeyResult.results ?? []) {
		if (!seenKeys.has(row.flag_key)) staleKeys.add(row.flag_key)
	}

	for (const key of [...staleKeys].sort()) {
		const global = globalByKey.get(key)
		flags.push({
			key,
			description: null,
			defaultEnabled: null,
			defaultAudience: null,
			stale: true,
			successMetric: null,
			global: global
				? {
						enabled: global.enabled === 1,
						rolloutPercent: global.rollout_percent,
						audience: normalizeAudience(global.audience),
						note: global.note,
						updatedByStableUserId: global.updated_by_stable_user_id,
						updatedAt: global.updated_at,
					}
				: null,
			overrides: overridesByKey.get(key) ?? [],
			orgOverrides: orgOverridesByKey.get(key) ?? [],
		})
	}

	return flags
}

export async function deleteStaleFeatureFlag(
	db: D1Database,
	key: string,
): Promise<boolean> {
	if (isFeatureFlagKey(key)) {
		throw new Error(
			`Cannot delete registry feature flag "${key}". Remove it from the code registry first.`,
		)
	}

	const results = await db.batch([
		db
			.prepare(`DELETE FROM feature_flag_user_overrides WHERE flag_key = ?`)
			.bind(key),
		db
			.prepare(`DELETE FROM feature_flag_repo_overrides WHERE flag_key = ?`)
			.bind(key),
		db
			.prepare(`DELETE FROM feature_flag_org_overrides WHERE flag_key = ?`)
			.bind(key),
		db.prepare(`DELETE FROM feature_flags WHERE key = ?`).bind(key),
	])

	return results.some((result) => (result?.meta.changes ?? 0) > 0)
}

export function isMissingFeatureFlagsTable(error: unknown) {
	const message = error instanceof Error ? error.message : ''
	const cause =
		error instanceof Error && error.cause instanceof Error
			? error.cause.message
			: ''
	const combined = `${message} ${cause}`
	// Incomplete workers-unit / handler test DBs often omit flag tables.
	return (
		combined.includes('no such table: feature_flags') ||
		combined.includes('no such table: feature_flag_user_overrides')
	)
}
