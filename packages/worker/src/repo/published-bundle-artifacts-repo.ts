import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type PublishedBundleArtifactRecord = {
	id: string
	userId: string
	sourceId: string
	publishedCommit: string
	artifactKind: string
	artifactName: string | null
	entryPoint: string
	kvKey: string
	dependenciesJson: string
	createdAt: string
	updatedAt: string
}

export type PublishedBundleArtifactUpsertInput = {
	userId: string
	sourceId: string
	publishedCommit: string
	artifactKind: string
	artifactName: string | null
	entryPoint: string
	kvKey: string
	dependenciesJson: string
}

export type StaticDependentBundleArtifactRow = {
	packageId: string
	packageKodyId: string
	packageName: string
	sourceId: string
	publishedCommit: string | null
	artifactKind: string
	artifactName: string | null
	entryPoint: string
	packageStale: boolean
	matchingArtifactCount: number
	matchingEntrypointCount: number
	packageBundledDependencyCommit: string | null
	bundledDependencyCommit: string | null
}

export type StaticDependentBundleArtifactCounts = {
	totalPackages: number
	stalePackages: number
}

function mapRow(row: Record<string, unknown>): PublishedBundleArtifactRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		sourceId: String(row['source_id']),
		publishedCommit: String(row['published_commit']),
		artifactKind: String(row['artifact_kind']),
		artifactName:
			row['artifact_name'] == null ? null : String(row['artifact_name']),
		entryPoint: String(row['entry_point']),
		kvKey: String(row['kv_key']),
		dependenciesJson: String(row['dependencies_json'] ?? '[]'),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapStaticDependentBundleArtifactRow(
	row: Record<string, unknown>,
): StaticDependentBundleArtifactRow {
	return {
		packageId: String(row['package_id']),
		packageKodyId: String(row['package_kody_id']),
		packageName: String(row['package_name']),
		sourceId: String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		artifactKind: String(row['artifact_kind']),
		artifactName:
			row['artifact_name'] == null ? null : String(row['artifact_name']),
		entryPoint: String(row['entry_point']),
		packageStale: Number(row['package_stale'] ?? 0) === 1,
		matchingArtifactCount: Number(row['matching_artifact_count'] ?? 0),
		matchingEntrypointCount: Number(row['matching_entrypoint_count'] ?? 0),
		packageBundledDependencyCommit:
			row['package_bundled_dependency_commit'] == null
				? null
				: String(row['package_bundled_dependency_commit']),
		bundledDependencyCommit:
			row['bundled_dependency_commit'] == null
				? null
				: String(row['bundled_dependency_commit']),
	}
}

export type PublishedBundleArtifactIdentity = {
	sourceId: string
	artifactKind: string
	artifactName: string | null
	entryPoint: string
}

/**
 * Stable key for identity rows. Matches the unique index's
 * `COALESCE(artifact_name, '')` null-vs-empty equivalence.
 */
export function publishedBundleArtifactIdentityKey(
	identity: PublishedBundleArtifactIdentity,
) {
	return [
		identity.sourceId,
		identity.artifactKind,
		identity.artifactName ?? '',
		identity.entryPoint,
	].join('\0')
}

export async function getPublishedBundleArtifactByIdentity(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
		artifactKind: string
		artifactName: string | null
		entryPoint: string
	},
) {
	const row = await db
		.prepare(
			`SELECT * FROM published_bundle_artifacts
			WHERE user_id = ? AND source_id = ? AND artifact_kind = ?
				AND COALESCE(artifact_name, '') = COALESCE(?, '')
				AND entry_point = ?
			LIMIT 1`,
		)
		.bind(
			input.userId,
			input.sourceId,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
		)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

/**
 * Batch form of {@link getPublishedBundleArtifactByIdentity}. One (or a few
 * chunked) SELECT(s) for many identities, preserving COALESCE null-vs-empty
 * artifact_name matching. Returns at most one row per identity key.
 */
export async function listPublishedBundleArtifactsByIdentities(
	db: D1Database,
	input: {
		userId: string
		identities: ReadonlyArray<PublishedBundleArtifactIdentity>
	},
): Promise<Map<string, PublishedBundleArtifactRecord>> {
	const uniqueByKey = new Map<string, PublishedBundleArtifactIdentity>()
	for (const identity of input.identities) {
		const key = publishedBundleArtifactIdentityKey(identity)
		if (!uniqueByKey.has(key)) uniqueByKey.set(key, identity)
	}
	const uniqueIdentities = [...uniqueByKey.values()]
	const found = new Map<string, PublishedBundleArtifactRecord>()
	if (uniqueIdentities.length === 0) return found

	// user_id + (source_id, artifact_kind, artifact_name, entry_point) per identity
	const bindsPerIdentity = 4
	const maxIdentitiesPerChunk = Math.max(
		1,
		Math.floor((maxD1BoundParameters - 1) / bindsPerIdentity),
	)
	for (const identityChunk of chunkArray(
		uniqueIdentities,
		maxIdentitiesPerChunk,
	)) {
		const clauses = identityChunk
			.map(
				() =>
					`(source_id = ? AND artifact_kind = ? AND COALESCE(artifact_name, '') = COALESCE(?, '') AND entry_point = ?)`,
			)
			.join(' OR ')
		const binds: Array<string | null> = [input.userId]
		for (const identity of identityChunk) {
			binds.push(
				identity.sourceId,
				identity.artifactKind,
				identity.artifactName,
				identity.entryPoint,
			)
		}
		const result = await db
			.prepare(
				`SELECT * FROM published_bundle_artifacts
				WHERE user_id = ? AND (${clauses})`,
			)
			.bind(...binds)
			.all<Record<string, unknown>>()
		for (const row of result.results ?? []) {
			const mapped = mapRow(row)
			found.set(
				publishedBundleArtifactIdentityKey({
					sourceId: mapped.sourceId,
					artifactKind: mapped.artifactKind,
					artifactName: mapped.artifactName,
					entryPoint: mapped.entryPoint,
				}),
				mapped,
			)
		}
	}
	return found
}

export async function countStaticDependentBundleArtifactPackages(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
		currentDependencyCommit: string
	},
): Promise<StaticDependentBundleArtifactCounts> {
	const row = await db
		.prepare(
			`WITH matching AS (
				SELECT
					p.id AS package_id,
					CASE
						WHEN json_extract(dependency.value, '$.publishedCommit') IS NULL
							OR json_extract(dependency.value, '$.publishedCommit') != ?
						THEN 1
						ELSE 0
					END AS stale
				FROM published_bundle_artifacts AS artifact
				JOIN json_each(artifact.dependencies_json) AS dependency
				JOIN entity_sources AS source
					ON source.id = artifact.source_id
					AND source.user_id = artifact.user_id
					AND source.entity_kind = 'package'
				JOIN saved_packages AS p
					ON p.id = source.entity_id
					AND p.user_id = artifact.user_id
				WHERE artifact.user_id = ?
					AND artifact.source_id != ?
					AND artifact.published_commit = source.published_commit
					AND json_extract(dependency.value, '$.sourceId') = ?
					AND json_extract(dependency.value, '$.transitive') IS NULL
					${andLiveDeletedAtSql('source')}${andLiveDeletedAtSql('p')}
			)
			SELECT
				COUNT(DISTINCT package_id) AS total_packages,
				COUNT(DISTINCT CASE WHEN stale = 1 THEN package_id END) AS stale_packages
			FROM matching`,
		)
		.bind(
			input.currentDependencyCommit,
			input.userId,
			input.sourceId,
			input.sourceId,
		)
		.first<Record<string, unknown>>()
	return {
		totalPackages: Number(row?.['total_packages'] ?? 0),
		stalePackages: Number(row?.['stale_packages'] ?? 0),
	}
}

export async function listStaticDependentBundleArtifactRows(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
		currentDependencyCommit: string
		packageLimit: number
		artifactsPerPackageLimit: number
	},
) {
	const result = await db
		.prepare(
			`WITH matching AS (
				SELECT
					p.id AS package_id,
					p.kody_id AS package_kody_id,
					p.name AS package_name,
					artifact.source_id,
					source.published_commit,
					artifact.artifact_kind,
					artifact.artifact_name,
					artifact.entry_point,
					json_extract(dependency.value, '$.publishedCommit') AS bundled_dependency_commit,
					CASE
						WHEN json_extract(dependency.value, '$.publishedCommit') IS NULL
							OR json_extract(dependency.value, '$.publishedCommit') != ?
						THEN 1
						ELSE 0
					END AS stale
				FROM published_bundle_artifacts AS artifact
				JOIN json_each(artifact.dependencies_json) AS dependency
				JOIN entity_sources AS source
					ON source.id = artifact.source_id
					AND source.user_id = artifact.user_id
					AND source.entity_kind = 'package'
				JOIN saved_packages AS p
					ON p.id = source.entity_id
					AND p.user_id = artifact.user_id
				WHERE artifact.user_id = ?
					AND artifact.source_id != ?
					AND artifact.published_commit = source.published_commit
					AND json_extract(dependency.value, '$.sourceId') = ?
					AND json_extract(dependency.value, '$.transitive') IS NULL
					${andLiveDeletedAtSql('source')}${andLiveDeletedAtSql('p')}
			),
			package_rollup AS (
				SELECT
					package_id,
					MAX(stale) AS package_stale,
					COUNT(*) AS matching_artifact_count,
					COUNT(DISTINCT entry_point) AS matching_entrypoint_count,
					CASE
						WHEN COUNT(DISTINCT COALESCE(bundled_dependency_commit, '__missing__')) = 1
						THEN MIN(bundled_dependency_commit)
						ELSE NULL
					END AS package_bundled_dependency_commit
				FROM matching
				GROUP BY package_id
			),
			entrypoint_representatives AS (
				SELECT
					matching.*,
					package_rollup.package_stale,
					package_rollup.matching_artifact_count,
					package_rollup.matching_entrypoint_count,
					package_rollup.package_bundled_dependency_commit,
					ROW_NUMBER() OVER (
						PARTITION BY matching.package_id, matching.entry_point
						ORDER BY stale DESC, artifact_kind ASC, COALESCE(artifact_name, '') ASC, entry_point ASC
					) AS entrypoint_artifact_rank
				FROM matching
				JOIN package_rollup
					ON package_rollup.package_id = matching.package_id
			),
			ranked_entrypoints AS (
				SELECT
					entrypoint_representatives.*,
					ROW_NUMBER() OVER (
						PARTITION BY package_id
						ORDER BY stale DESC, entry_point ASC
					) AS entrypoint_rank
				FROM entrypoint_representatives
				WHERE entrypoint_artifact_rank = 1
			),
			ranked_packages AS (
				SELECT
					ranked_entrypoints.*,
					DENSE_RANK() OVER (
						ORDER BY package_stale DESC, package_name ASC, package_id ASC
					) AS package_rank
				FROM ranked_entrypoints
			)
			SELECT
				package_id,
				package_kody_id,
				package_name,
				source_id,
				published_commit,
				artifact_kind,
				artifact_name,
				entry_point,
				package_stale,
				matching_artifact_count,
				matching_entrypoint_count,
				package_bundled_dependency_commit,
				bundled_dependency_commit
			FROM ranked_packages
			WHERE package_rank <= ? AND entrypoint_rank <= ?
			ORDER BY package_rank ASC, entrypoint_rank ASC`,
		)
		.bind(
			input.currentDependencyCommit,
			input.userId,
			input.sourceId,
			input.sourceId,
			input.packageLimit,
			input.artifactsPerPackageLimit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapStaticDependentBundleArtifactRow)
}

export async function listPublishedBundleArtifactsBySourceId(
	db: D1Database,
	userId: string,
	sourceId: string,
) {
	const result = await db
		.prepare(
			`SELECT * FROM published_bundle_artifacts
			WHERE user_id = ? AND source_id = ?
			ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(userId, sourceId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapRow)
}

export function isPublishedBundleArtifactIdentityConflict(error: unknown) {
	return errorCauseChainIncludes(
		error,
		(message) =>
			/idx_published_bundle_artifacts_(source_)?identity/i.test(message) ||
			/unique constraint failed:.*published_bundle_artifacts/i.test(message),
	)
}

export async function insertPublishedBundleArtifactRow(
	db: D1Database,
	input: PublishedBundleArtifactUpsertInput,
) {
	const now = new Date().toISOString()
	const id = crypto.randomUUID()
	await prepareUnguardedInsert(db, input, id, now).run()
	return id
}

/**
 * Insert an identity row only while `entity_sources.published_commit` still
 * matches the write. Zero changes means the live commit moved — treat as a
 * stale write and leave the identity table alone.
 */
async function insertPublishedBundleArtifactRowForLiveCommit(
	db: D1Database,
	input: PublishedBundleArtifactUpsertInput,
) {
	const now = new Date().toISOString()
	const id = crypto.randomUUID()
	const result = await prepareGuardedInsert(db, input, id, now).run()
	return (result.meta.changes ?? 0) > 0 ? id : null
}

function publishedCommitFromRow(
	row: Record<string, unknown> | null | undefined,
) {
	const commit = row?.['published_commit']
	return typeof commit === 'string' && commit.length > 0 ? commit : null
}

async function getLivePublishedCommit(
	db: D1Database,
	input: { userId: string; sourceId: string },
) {
	try {
		const row = await db
			.prepare(
				`SELECT published_commit FROM entity_sources
				WHERE id = ? AND user_id = ?
				${andLiveDeletedAtSql()} LIMIT 1`,
			)
			.bind(input.sourceId, input.userId)
			.first<Record<string, unknown>>()
		return publishedCommitFromRow(row)
	} catch {
		// Tests and callers without entity_sources keep last-write-wins.
		return null
	}
}

/**
 * Batch form of {@link getLivePublishedCommit}. One (or a few chunked)
 * SELECT(s) for many source ids owned by `userId`. Missing sources map to
 * `null` (same as the single-row helper when no live row matches).
 */
async function listLivePublishedCommitsBySourceIds(
	db: D1Database,
	input: { userId: string; sourceIds: ReadonlyArray<string> },
): Promise<Map<string, string | null>> {
	const uniqueIds = [...new Set(input.sourceIds)]
	const found = new Map<string, string | null>()
	if (uniqueIds.length === 0) return found
	try {
		for (const idChunk of chunkArray(uniqueIds, maxD1BoundParameters - 1)) {
			const placeholders = idChunk.map(() => '?').join(', ')
			const result = await db
				.prepare(
					`SELECT id, published_commit FROM entity_sources
					WHERE user_id = ? AND id IN (${placeholders})
					${andLiveDeletedAtSql()}`,
				)
				.bind(input.userId, ...idChunk)
				.all<Record<string, unknown>>()
			for (const row of result.results ?? []) {
				found.set(String(row['id']), publishedCommitFromRow(row))
			}
		}
	} catch (error) {
		// Empty map + failure matches getLivePublishedCommit's missing
		// entity_sources fixture path (last-write-wins). A later chunk failing
		// after earlier rows landed must not treat unread sources as null live
		// commits — that would plan unguarded writes over a newer identity.
		if (found.size === 0) return found
		throw error
	}
	return found
}

/** Cap write statements per `db.batch` (same order as usage rollup upserts). */
const publishedBundleArtifactUpsertBatchSize = 50

function prepareUnguardedInsert(
	db: D1Database,
	input: PublishedBundleArtifactUpsertInput,
	id: string,
	now: string,
) {
	return db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
			input.kvKey,
			input.dependenciesJson,
			now,
			now,
		)
}

function prepareGuardedInsert(
	db: D1Database,
	input: PublishedBundleArtifactUpsertInput,
	id: string,
	now: string,
) {
	return db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE EXISTS (
				SELECT 1 FROM entity_sources
				WHERE id = ?
					AND user_id = ?
					AND published_commit = ?
					${andLiveDeletedAtSql()}
			)`,
		)
		.bind(
			id,
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
			input.kvKey,
			input.dependenciesJson,
			now,
			now,
			input.sourceId,
			input.userId,
			input.publishedCommit,
		)
}

function prepareUnguardedUpdate(
	db: D1Database,
	input: { id: string } & PublishedBundleArtifactUpsertInput,
	now: string,
) {
	return db
		.prepare(
			`UPDATE published_bundle_artifacts
			SET user_id = ?, source_id = ?, published_commit = ?, artifact_kind = ?,
				artifact_name = ?, entry_point = ?, kv_key = ?, dependencies_json = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
			input.kvKey,
			input.dependenciesJson,
			now,
			input.id,
		)
}

function prepareGuardedUpdate(
	db: D1Database,
	input: { id: string } & PublishedBundleArtifactUpsertInput,
	now: string,
) {
	return db
		.prepare(
			`UPDATE published_bundle_artifacts
			SET user_id = ?, source_id = ?, published_commit = ?, artifact_kind = ?,
				artifact_name = ?, entry_point = ?, kv_key = ?, dependencies_json = ?,
				updated_at = ?
			WHERE id = ?
				AND EXISTS (
					SELECT 1 FROM entity_sources
					WHERE id = ?
						AND user_id = ?
						AND published_commit = ?
						${andLiveDeletedAtSql()}
				)`,
		)
		.bind(
			input.userId,
			input.sourceId,
			input.publishedCommit,
			input.artifactKind,
			input.artifactName,
			input.entryPoint,
			input.kvKey,
			input.dependenciesJson,
			now,
			input.id,
			input.sourceId,
			input.userId,
			input.publishedCommit,
		)
}

/**
 * Write one identity row. Isolated rebuilds, overlapping publishes, and
 * hydration can race the same (kind, name, entry) after a source publish
 * already succeeded; a UNIQUE on that index updates the winner instead of
 * aborting later importable-module targets. A persist whose commit is no
 * longer `entity_sources.published_commit` leaves the live identity alone,
 * and both INSERT and UPDATE are gated on the live commit so a concurrent
 * publish cannot be overwritten by a stale rebuild.
 */
export async function upsertPublishedBundleArtifactRow(
	db: D1Database,
	input: PublishedBundleArtifactUpsertInput,
) {
	const identity = {
		userId: input.userId,
		sourceId: input.sourceId,
		artifactKind: input.artifactKind,
		artifactName: input.artifactName,
		entryPoint: input.entryPoint,
	}
	const existing = await getPublishedBundleArtifactByIdentity(db, identity)
	const liveCommit = await getLivePublishedCommit(db, input)
	if (liveCommit != null && liveCommit !== input.publishedCommit) {
		return existing?.id ?? null
	}
	try {
		if (existing) {
			if (liveCommit == null) {
				// No readable entity_sources row (test fixtures): last-write-wins.
				await updatePublishedBundleArtifactRow(db, {
					id: existing.id,
					...input,
				})
			} else {
				// Atomic live-commit guard: a concurrent publish that advances
				// entity_sources between the stale check and this write must not
				// retarget the identity row to an older commit.
				await updatePublishedBundleArtifactRowForLiveCommit(db, {
					id: existing.id,
					...input,
				})
			}
			return existing.id
		}
		if (liveCommit == null) {
			// No readable entity_sources row (test fixtures): last-write-wins.
			return await insertPublishedBundleArtifactRow(db, input)
		}
		// Atomic live-commit guard on INSERT: a concurrent publish that advances
		// entity_sources between the stale check and this write must not create
		// an identity row stamped with the older commit.
		return await insertPublishedBundleArtifactRowForLiveCommit(db, input)
	} catch (error) {
		if (!isPublishedBundleArtifactIdentityConflict(error)) {
			throw error
		}
		const raced = await getPublishedBundleArtifactByIdentity(db, identity)
		if (!raced) {
			throw error
		}
		const liveAfterRace = await getLivePublishedCommit(db, input)
		if (liveAfterRace != null && liveAfterRace !== input.publishedCommit) {
			return raced.id
		}
		if (liveAfterRace == null) {
			const updated = await updatePublishedBundleArtifactRow(db, {
				id: raced.id,
				...input,
			})
			if (!updated) {
				throw error
			}
			return raced.id
		}
		const updated = await updatePublishedBundleArtifactRowForLiveCommit(db, {
			id: raced.id,
			...input,
		})
		if (!updated) {
			// Commit moved under us — leave the live identity alone.
			return raced.id
		}
		return raced.id
	}
}

type BatchedUpsertPlanEntry = {
	inputIndex: number
	input: PublishedBundleArtifactUpsertInput
	id: string
	kind: 'insert' | 'update'
	guarded: boolean
}

/**
 * Batch form of {@link upsertPublishedBundleArtifactRow}. One live-commit
 * read per distinct `(userId, sourceId)`, one batched identity read, then
 * chunked `db.batch` writes. Preserves the single-row guarantees: stale
 * commits leave the identity alone, INSERT/UPDATE stay EXISTS-gated when a
 * live commit is known, UNIQUE races resolve to updating the winner, and
 * `liveCommit == null` stays last-write-wins. Returns ids in input order
 * (`null` when a gated insert refused to create a stale row).
 */
export async function upsertPublishedBundleArtifactRows(
	db: D1Database,
	inputs: ReadonlyArray<PublishedBundleArtifactUpsertInput>,
): Promise<Array<string | null>> {
	if (inputs.length === 0) return []
	if (inputs.length === 1) {
		const only = inputs[0]
		if (!only) return []
		return [await upsertPublishedBundleArtifactRow(db, only)]
	}

	// Last write wins for duplicate identities in one batch (same as sequential
	// upserts). Keep the last input index so results align with callers.
	const uniqueByKey = new Map<
		string,
		{ input: PublishedBundleArtifactUpsertInput; inputIndex: number }
	>()
	for (const [inputIndex, input] of inputs.entries()) {
		uniqueByKey.set(
			publishedBundleArtifactIdentityKey({
				sourceId: input.sourceId,
				artifactKind: input.artifactKind,
				artifactName: input.artifactName,
				entryPoint: input.entryPoint,
			}),
			{ input, inputIndex },
		)
	}
	const uniqueEntries = [...uniqueByKey.values()]

	const results: Array<string | null> = inputs.map(() => null)

	// Prefetch live commits per user (rebuild chunks are single-user).
	const sourceIdsByUser = new Map<string, Array<string>>()
	for (const { input } of uniqueEntries) {
		const list = sourceIdsByUser.get(input.userId) ?? []
		list.push(input.sourceId)
		sourceIdsByUser.set(input.userId, list)
	}
	const liveByUserAndSource = new Map<string, string | null>()
	for (const [userId, sourceIds] of sourceIdsByUser) {
		const liveBySource = await listLivePublishedCommitsBySourceIds(db, {
			userId,
			sourceIds,
		})
		for (const sourceId of new Set(sourceIds)) {
			liveByUserAndSource.set(
				`${userId}\0${sourceId}`,
				liveBySource.get(sourceId) ?? null,
			)
		}
	}

	// Prefetch identities per user.
	const identitiesByUser = new Map<
		string,
		Array<PublishedBundleArtifactIdentity>
	>()
	for (const { input } of uniqueEntries) {
		const list = identitiesByUser.get(input.userId) ?? []
		list.push({
			sourceId: input.sourceId,
			artifactKind: input.artifactKind,
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
		})
		identitiesByUser.set(input.userId, list)
	}
	const existingByUserAndKey = new Map<string, PublishedBundleArtifactRecord>()
	for (const [userId, identities] of identitiesByUser) {
		const found = await listPublishedBundleArtifactsByIdentities(db, {
			userId,
			identities,
		})
		for (const [key, row] of found) {
			existingByUserAndKey.set(`${userId}\0${key}`, row)
		}
	}

	const now = new Date().toISOString()
	const plan: Array<BatchedUpsertPlanEntry> = []
	for (const { input, inputIndex } of uniqueEntries) {
		const identityKey = publishedBundleArtifactIdentityKey({
			sourceId: input.sourceId,
			artifactKind: input.artifactKind,
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
		})
		const existing = existingByUserAndKey.get(`${input.userId}\0${identityKey}`)
		const liveCommit =
			liveByUserAndSource.get(`${input.userId}\0${input.sourceId}`) ?? null
		if (liveCommit != null && liveCommit !== input.publishedCommit) {
			results[inputIndex] = existing?.id ?? null
			continue
		}
		if (existing) {
			plan.push({
				inputIndex,
				input,
				id: existing.id,
				kind: 'update',
				guarded: liveCommit != null,
			})
			results[inputIndex] = existing.id
			continue
		}
		const id = crypto.randomUUID()
		plan.push({
			inputIndex,
			input,
			id,
			kind: 'insert',
			guarded: liveCommit != null,
		})
		// Tentative; gated insert may refuse (changes === 0).
		results[inputIndex] = id
	}

	if (plan.length === 0) {
		return fillDuplicateIdentityResults(inputs, results, uniqueByKey)
	}

	try {
		await runPublishedBundleArtifactUpsertPlan(db, plan, now, results)
	} catch (error) {
		if (!isPublishedBundleArtifactIdentityConflict(error)) {
			throw error
		}
		// D1 batches are transactional: one UNIQUE race rolls back the chunk.
		// Fall back to the single-row path (which recovers races) for the
		// planned writes only — stale skips already have results.
		for (const entry of plan) {
			results[entry.inputIndex] = await upsertPublishedBundleArtifactRow(
				db,
				entry.input,
			)
		}
	}

	return fillDuplicateIdentityResults(inputs, results, uniqueByKey)
}

function fillDuplicateIdentityResults(
	inputs: ReadonlyArray<PublishedBundleArtifactUpsertInput>,
	results: Array<string | null>,
	uniqueByKey: Map<
		string,
		{ input: PublishedBundleArtifactUpsertInput; inputIndex: number }
	>,
) {
	for (const [inputIndex, input] of inputs.entries()) {
		if (results[inputIndex] != null) continue
		const winner = uniqueByKey.get(
			publishedBundleArtifactIdentityKey({
				sourceId: input.sourceId,
				artifactKind: input.artifactKind,
				artifactName: input.artifactName,
				entryPoint: input.entryPoint,
			}),
		)
		if (!winner || winner.inputIndex === inputIndex) continue
		results[inputIndex] = results[winner.inputIndex] ?? null
	}
	return results
}

async function runPublishedBundleArtifactUpsertPlan(
	db: D1Database,
	plan: ReadonlyArray<BatchedUpsertPlanEntry>,
	now: string,
	results: Array<string | null>,
) {
	for (const planChunk of chunkArray(
		[...plan],
		publishedBundleArtifactUpsertBatchSize,
	)) {
		const statements = planChunk.map((entry) => {
			if (entry.kind === 'update') {
				const updateInput = { id: entry.id, ...entry.input }
				return entry.guarded
					? prepareGuardedUpdate(db, updateInput, now)
					: prepareUnguardedUpdate(db, updateInput, now)
			}
			return entry.guarded
				? prepareGuardedInsert(db, entry.input, entry.id, now)
				: prepareUnguardedInsert(db, entry.input, entry.id, now)
		})
		const batchResults = await db.batch(statements)
		for (const [index, entry] of planChunk.entries()) {
			if (entry.kind !== 'insert' || !entry.guarded) continue
			const batchResult = batchResults[index] as
				| { meta?: { changes?: number } }
				| undefined
			if ((batchResult?.meta?.changes ?? 0) <= 0) {
				results[entry.inputIndex] = null
			}
		}
	}
}

/**
 * Update an identity row only while `entity_sources.published_commit` still
 * matches the write. Callers only use this when a live commit is already
 * known; fixtures without `entity_sources` take the unguarded path via
 * `liveCommit == null` in `upsertPublishedBundleArtifactRow`. Failures
 * propagate — never fall back to an unguarded UPDATE.
 */
async function updatePublishedBundleArtifactRowForLiveCommit(
	db: D1Database,
	input: { id: string } & PublishedBundleArtifactUpsertInput,
) {
	const now = new Date().toISOString()
	const result = await prepareGuardedUpdate(db, input, now).run()
	return (result.meta.changes ?? 0) > 0
}

export async function updatePublishedBundleArtifactRow(
	db: D1Database,
	input: { id: string } & PublishedBundleArtifactUpsertInput,
) {
	const result = await prepareUnguardedUpdate(
		db,
		input,
		new Date().toISOString(),
	).run()
	return (result.meta.changes ?? 0) > 0
}

export async function deletePublishedBundleArtifactRowsBySourceId(
	db: D1Database,
	userId: string,
	sourceId: string,
) {
	const result = await db
		.prepare(
			`DELETE FROM published_bundle_artifacts WHERE user_id = ? AND source_id = ?`,
		)
		.bind(userId, sourceId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
