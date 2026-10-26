import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { d1ContainsLikePattern } from '#worker/d1-like-pattern.ts'
import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import { classifyForkListingRelation } from '#universal/community-listing-ahead.ts'
import { buildLengthSafeVectorId } from '#worker/vectorize/vector-ids.ts'
import { stampFirstSavedPackage } from '#worker/identity/activation-stamps.ts'
import { type OnboardingFunnelEnv } from '#worker/identity/onboarding-funnel-event.ts'
import {
	getPackageNameLeaf,
	getPackageNameScope,
	isScopedPackageName,
} from './package-name.ts'
import { clearCachedPackageAppCustomHostnames } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import {
	packageAuditActions,
	packageSettingsAuditDetails,
	readPackageSettingsForAudit,
	recordPackageAudit,
} from './package-audit.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import {
	kodyPackageIdPattern,
	type SavedPackageCommunityProvenance,
	type SavedPackageRecord,
	type SavedPackageRow,
	type SavedPackageWithCommunityProvenanceRecord,
} from './types.ts'

const maxSqlBindingsPerChunk = 90

export function savedPackageVectorId(packageId: string) {
	return buildLengthSafeVectorId({ prefix: 'package', rawId: packageId })
}

const savedPackageSelectColumns = `saved_packages.id, saved_packages.user_id, saved_packages.name,
				saved_packages.kody_id, saved_packages.description, saved_packages.tags_json,
				saved_packages.search_text, saved_packages.source_id, saved_packages.has_app,
				saved_packages.has_skills,
				saved_packages.hidden, saved_packages.is_private,
				saved_packages.is_internet_visible, saved_packages.locked_at,
				saved_packages.created_at, saved_packages.updated_at`

const savedPackageCommunityProvenanceSelectColumns = `${savedPackageSelectColumns},
				community_forks.listing_id AS source_listing_id,
				CASE
					WHEN community_forks.id IS NULL THEN NULL
					WHEN community_listings.id IS NULL THEN 0
					ELSE 1
				END AS listing_current,
				community_forks.listing_kody_id AS listing_kody_id,
				community_listings.name AS listing_name,
				community_forks.origin_commit AS origin_commit,
				community_listings.pinned_commit AS listing_pinned_commit,
				community_listings.published_at AS listing_published_at`

const savedPackageCommunityProvenanceJoins = `LEFT JOIN community_forks
				ON community_forks.forked_package_id = saved_packages.id
				AND community_forks.forker_user_id = saved_packages.user_id
			LEFT JOIN community_listings
				ON community_listings.id = community_forks.listing_id
				AND community_listings.status = 'active'${andLiveDeletedAtSql('community_listings')}`

function mapSavedPackageRow(row: Record<string, unknown>): SavedPackageRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']) as OwnerId,
		name: String(row['name']),
		kodyId: String(row['kody_id']),
		description: String(row['description']),
		tags: parseTagsJson(row['tags_json']),
		searchText:
			row['search_text'] == null ? null : String(row['search_text']).trim(),
		sourceId: String(row['source_id']),
		hasApp:
			row['has_app'] === 1 || row['has_app'] === '1' || row['has_app'] === true,
		hasSkills:
			row['has_skills'] === 1 ||
			row['has_skills'] === '1' ||
			row['has_skills'] === true,
		hidden:
			row['hidden'] === 1 || row['hidden'] === '1' || row['hidden'] === true,
		isPrivate:
			row['is_private'] === 1 ||
			row['is_private'] === '1' ||
			row['is_private'] === true,
		isInternetVisible:
			row['is_internet_visible'] === 1 ||
			row['is_internet_visible'] === '1' ||
			row['is_internet_visible'] === true,
		lockedAt:
			row['locked_at'] == null || String(row['locked_at']).trim() === ''
				? null
				: String(row['locked_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapSavedPackageWithCommunityProvenanceRow(
	row: Record<string, unknown>,
): SavedPackageWithCommunityProvenanceRecord {
	const savedPackage = mapSavedPackageRow(row)
	if (row['source_listing_id'] == null) {
		return {
			...savedPackage,
			...emptyCommunityProvenance,
		}
	}
	const originCommit =
		row['origin_commit'] == null ? null : String(row['origin_commit'])
	const listingPinnedCommit =
		row['listing_pinned_commit'] == null
			? null
			: String(row['listing_pinned_commit'])
	const listingCurrent =
		row['listing_current'] === 1 ||
		row['listing_current'] === '1' ||
		row['listing_current'] === true
	return {
		...savedPackage,
		sourceListingId: String(row['source_listing_id']),
		listingCurrent,
		listingKodyId:
			row['listing_kody_id'] == null ? null : String(row['listing_kody_id']),
		listingName:
			row['listing_name'] == null ? null : String(row['listing_name']),
		originCommit,
		listingPinnedCommit,
		listingPublishedAt:
			row['listing_published_at'] == null
				? null
				: String(row['listing_published_at']),
		listingAhead:
			listingCurrent &&
			classifyForkListingRelation({ originCommit, listingPinnedCommit }) ===
				'outdated',
		forkListingRelation: listingCurrent
			? classifyForkListingRelation({ originCommit, listingPinnedCommit })
			: null,
	}
}

const emptyCommunityProvenance: SavedPackageCommunityProvenance = {
	sourceListingId: null,
	listingCurrent: null,
	listingKodyId: null,
	listingName: null,
	originCommit: null,
	listingPinnedCommit: null,
	listingPublishedAt: null,
	listingAhead: null,
	forkListingRelation: null,
}
/**
 * Inserts a saved-package row. Returns whether this insert newly claimed
 * `users.first_saved_package_at` for the actor (or the owning user when no
 * actor is passed). Callers that stamp before a projection refresh must Kit
 * sync when this returns true — refresh sees an existing row and will not.
 *
 * `kody_id` is always the leaf of `name` (#1909 phase 2). Callers must not
 * invent a second id; an optional leftover `kody_id` field is ignored.
 */
export async function insertSavedPackage(
	db: D1Database,
	row: Omit<
		SavedPackageRow,
		| 'created_at'
		| 'updated_at'
		| 'locked_at'
		| 'is_internet_visible'
		| 'kody_id'
	> & {
		created_at?: string
		updated_at?: string
		/** Defaults to 0 (private app serving). */
		is_internet_visible?: 0 | 1
		/** @deprecated Ignored; derived from `name` leaf (#1909 phase 2). */
		kody_id?: string
	},
	telemetry?: OnboardingFunnelEnv | null,
	options?: { stamp?: boolean; actorUserId?: PersonId },
): Promise<boolean> {
	const now = new Date().toISOString()
	const kodyId = getPackageNameLeaf(row.name)
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text,
				source_id, has_app, has_skills, hidden, is_private,
				is_internet_visible, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.name,
			kodyId,
			row.description,
			row.tags_json,
			row.search_text ?? null,
			row.source_id,
			row.has_app,
			row.has_skills,
			row.hidden ?? 0,
			row.is_private ?? 1,
			row.is_internet_visible ?? 0,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
	if (options?.stamp === false) return false
	return await stampFirstSavedPackage(
		db,
		{
			stableUserId: options?.actorUserId ?? row.user_id,
			at: row.created_at ?? now,
		},
		telemetry,
	)
}

/**
 * Next `updated_at` that is strictly after `previous` (ISO). Same-ms clears
 * still advance so a concurrent CAS writer cannot reuse a stale stamp.
 */
export function nextSavedPackageUpdatedAt(
	previous: string | null | undefined,
): string {
	const now = new Date().toISOString()
	if (!previous || now > previous) return now
	const bumpedMs = Date.parse(previous) + 1
	if (Number.isNaN(bumpedMs)) return now
	return new Date(bumpedMs).toISOString()
}

export async function updateSavedPackage(
	db: D1Database,
	input: {
		userId: string
		packageId: string
		name?: string
		description?: string
		tagsJson?: string
		searchText?: string | null
		sourceId?: string
		hasApp?: boolean
		hasSkills?: boolean
		hidden?: boolean
		isPrivate?: boolean
		isInternetVisible?: boolean
		/** Override the stamp written to `updated_at` (defaults to now). */
		updatedAt?: string
		/**
		 * When set, the update only applies if `updated_at` still matches.
		 * Used so a concurrent clearer cannot be overwritten by a stale writer.
		 */
		expectedUpdatedAt?: string
		/**
		 * Audits visibility, internet visible, and listing changes. Required so
		 * a new settings write path cannot skip the audit; metadata refreshes
		 * pass null.
		 */
		audit: OrgAuditWriter | null
	},
) {
	const assignments: Array<string> = []
	const values: Array<unknown> = []

	function addAssignment(column: string, value: unknown) {
		assignments.push(`${column} = ?`)
		values.push(value)
	}

	if (input.name !== undefined) {
		addAssignment('name', input.name)
		// Keep the leftover column in lockstep with the name leaf until phase 4.
		addAssignment('kody_id', getPackageNameLeaf(input.name))
	}
	if (input.description !== undefined) {
		addAssignment('description', input.description)
	}
	if (input.tagsJson !== undefined) {
		addAssignment('tags_json', input.tagsJson)
	}
	if (input.searchText !== undefined) {
		addAssignment('search_text', input.searchText ?? null)
	}
	if (input.sourceId !== undefined) {
		addAssignment('source_id', input.sourceId)
	}
	if (input.hasApp !== undefined) {
		addAssignment('has_app', input.hasApp ? 1 : 0)
	}
	if (input.hasSkills !== undefined) {
		addAssignment('has_skills', input.hasSkills ? 1 : 0)
	}
	if (input.hidden !== undefined) {
		addAssignment('hidden', input.hidden ? 1 : 0)
	}
	if (input.isPrivate !== undefined) {
		addAssignment('is_private', input.isPrivate ? 1 : 0)
	}
	if (input.isInternetVisible !== undefined) {
		addAssignment('is_internet_visible', input.isInternetVisible ? 1 : 0)
	}

	addAssignment('updated_at', input.updatedAt ?? new Date().toISOString())

	const expectedUpdatedAtClause =
		input.expectedUpdatedAt === undefined ? '' : ' AND updated_at = ?'
	const bindValues =
		input.expectedUpdatedAt === undefined
			? [...values, input.packageId, input.userId]
			: [...values, input.packageId, input.userId, input.expectedUpdatedAt]

	const update = db
		.prepare(
			`UPDATE saved_packages
			SET ${assignments.join(', ')}
			WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}${expectedUpdatedAtClause}`,
		)
		.bind(...bindValues)
	// Visibility decides who may open the app, so it moves the org access
	// epoch with it and outstanding package-app access decisions go stale.
	const changesVisibility =
		input.hidden !== undefined ||
		input.isPrivate !== undefined ||
		input.isInternetVisible !== undefined
	const settingsBefore =
		input.audit && changesVisibility
			? await readPackageSettingsForAudit(db, input)
			: null
	const [result] = changesVisibility
		? await db.batch([
				update,
				bumpAccessEpochStatement(db, input.userId, {
					onlyIfPreviousChanged: true,
				}),
			])
		: [await update.run()]

	const changed = (result?.meta.changes ?? 0) > 0
	// App-level custom hostname cache embeds the package name leaf (kodyId).
	// A rename must drop cached Host mappings in this isolate or handoff
	// rejects the new slug for up to the cache TTL.
	if (changed && input.name !== undefined) {
		clearCachedPackageAppCustomHostnames(db)
	}
	const settingsDetails =
		changed && settingsBefore
			? packageSettingsAuditDetails(settingsBefore, input)
			: null
	if (settingsDetails) {
		await recordPackageAudit(input.audit, {
			orgId: input.userId,
			packageId: input.packageId,
			name: input.name ?? settingsBefore!.name,
			action: packageAuditActions.updated,
			details: settingsDetails,
		})
	}
	return changed
}

export async function getSavedPackageLockedAt(
	db: D1Database,
	input: {
		userId: string
		packageId: string
	},
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT locked_at
			FROM saved_packages
			WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.packageId, input.userId)
		.first<{ locked_at: string | null }>()
	if (!row || row.locked_at == null || String(row.locked_at).trim() === '') {
		return null
	}
	return String(row.locked_at)
}

export async function setSavedPackageLockedAt(
	db: D1Database,
	input: {
		userId: string
		packageId: string
		lockedAt: string | null
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE saved_packages
			SET locked_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.lockedAt,
			new Date().toISOString(),
			input.packageId,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteSavedPackage(
	db: D1Database,
	input: {
		userId: string
		packageId: string
	},
) {
	const [result] = await db.batch([
		db
			.prepare(
				`DELETE FROM saved_packages WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(input.packageId, input.userId),
		bumpAccessEpochStatement(db, input.userId, { onlyIfPreviousChanged: true }),
	])
	return (result?.meta.changes ?? 0) > 0
}

export async function getSavedPackageById(
	db: D1Database,
	input: {
		userId: string
		packageId: string
	},
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${savedPackageSelectColumns}
			FROM saved_packages
			WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.packageId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

/**
 * A live saved package by id in whichever org owns it. Only for facts that
 * belong to the package itself (its manifest), never for access decisions.
 */
export async function getSavedPackageByIdInAnyOrg(
	db: D1Database,
	packageId: string,
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${savedPackageSelectColumns}
			FROM saved_packages
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(packageId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

export async function getSavedPackageWithCommunityProvenanceById(
	db: D1Database,
	input: {
		userId: string
		packageId: string
	},
): Promise<SavedPackageWithCommunityProvenanceRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${savedPackageCommunityProvenanceSelectColumns}
			FROM saved_packages
			${savedPackageCommunityProvenanceJoins}
			WHERE saved_packages.id = ? AND saved_packages.user_id = ?${andLiveDeletedAtSql('saved_packages')}`,
		)
		.bind(input.packageId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageWithCommunityProvenanceRow(row) : null
}

export type SavedPackageRefLookup = {
	userId: string
	/** Package slug (name leaf), `@scope/leaf`, or saved-package UUID. */
	ref: string
	/** `slug` limits matching to the name leaf, for URL path segments. */
	match?: 'any' | 'slug'
	/**
	 * When no live package owns the slug, follow `package_slug_redirects` to
	 * the package that retired it. Only for URLs third parties hold on to
	 * (webhook ingress, invocation, public pages); collision checks must not.
	 */
	followRedirects?: boolean
}

const savedPackageSlugSql = `substr(saved_packages.name, instr(saved_packages.name, '/') + 1)`

type SavedPackageRefQuery = {
	where: string
	orderBy: string
	values: Array<unknown>
}

function buildSavedPackageRefQuery(input: {
	userId: string
	ref: string
	match?: 'any' | 'slug'
}): SavedPackageRefQuery | null {
	const ref = input.ref.trim()
	if (!ref) return null
	const slug = ref.toLowerCase()
	if (input.match === 'slug') {
		if (!kodyPackageIdPattern.test(slug)) return null
		return {
			where: `saved_packages.user_id = ? AND ${savedPackageSlugSql} = ?`,
			orderBy: 'saved_packages.id',
			values: [input.userId, slug],
		}
	}
	if (ref.startsWith('@')) {
		if (!isScopedPackageName(ref)) return null
		return {
			where: 'saved_packages.user_id = ? AND saved_packages.name = ?',
			orderBy: 'saved_packages.id',
			values: [input.userId, slug],
		}
	}
	return {
		where: `saved_packages.user_id = ?
				AND (saved_packages.id IN (?, ?) OR ${savedPackageSlugSql} = ?)`,
		orderBy: `CASE WHEN saved_packages.id IN (?, ?) THEN 0 ELSE 1 END`,
		values: [input.userId, ref, slug, slug, ref, slug],
	}
}

async function findSavedPackageIdBySlugRedirect(
	db: D1Database,
	input: { userId: string; ref: string },
): Promise<string | null> {
	const ref = input.ref.trim()
	const slug = (
		ref.startsWith('@') ? getPackageNameLeaf(ref) : ref
	).toLowerCase()
	if (!kodyPackageIdPattern.test(slug)) return null
	const row = await db
		.prepare(
			`SELECT package_id FROM (
				SELECT package_id, 0 AS priority FROM package_slug_redirects
				WHERE user_id = ? AND old_slug = ?
				UNION ALL
				SELECT package_id, 1 AS priority FROM package_kody_id_redirects
				WHERE user_id = ? AND old_kody_id = ?
			)
			ORDER BY priority
			LIMIT 1`,
		)
		.bind(input.userId, slug, input.userId, slug)
		.first<{ package_id: string }>()
	return row?.package_id ?? null
}

async function resolveSavedPackageRefRow(
	db: D1Database,
	input: SavedPackageRefLookup & { columns: string; joins: string },
): Promise<Record<string, unknown> | null> {
	const query = buildSavedPackageRefQuery(input)
	if (!query) return null
	const select = (where: string, orderBy: string) =>
		`SELECT ${input.columns}
			FROM saved_packages
			${input.joins}
			WHERE ${where}${andLiveDeletedAtSql('saved_packages')}
			ORDER BY ${orderBy}
			LIMIT 1`
	const live = await db
		.prepare(select(query.where, query.orderBy))
		.bind(...query.values)
		.first<Record<string, unknown>>()
	if (live || !input.followRedirects) return live ?? null
	const packageId = await findSavedPackageIdBySlugRedirect(db, input)
	if (!packageId) return null
	const redirected = await db
		.prepare(
			select(
				'saved_packages.user_id = ? AND saved_packages.id = ?',
				'saved_packages.id',
			),
		)
		.bind(input.userId, packageId)
		.first<Record<string, unknown>>()
	if (!redirected) return null
	// A scoped ref only follows a redirect inside the package's current scope.
	if (
		input.ref.trim().startsWith('@') &&
		getPackageNameScope(input.ref)?.toLowerCase() !==
			getPackageNameScope(String(redirected['name']))
	) {
		return null
	}
	return redirected
}

/**
 * The one saved-package lookup by caller-supplied identity. The slug is the
 * leaf of `saved_packages.name`; a UUID match wins over a slug match.
 */
export async function resolveSavedPackageRef(
	db: D1Database,
	input: SavedPackageRefLookup,
): Promise<SavedPackageRecord | null> {
	const row = await resolveSavedPackageRefRow(db, {
		...input,
		columns: savedPackageSelectColumns,
		joins: '',
	})
	return row ? mapSavedPackageRow(row) : null
}

export async function resolveSavedPackageRefWithCommunityProvenance(
	db: D1Database,
	input: SavedPackageRefLookup,
): Promise<SavedPackageWithCommunityProvenanceRecord | null> {
	const row = await resolveSavedPackageRefRow(db, {
		...input,
		columns: savedPackageCommunityProvenanceSelectColumns,
		joins: savedPackageCommunityProvenanceJoins,
	})
	return row ? mapSavedPackageWithCommunityProvenanceRow(row) : null
}

export async function getSavedPackageByName(
	db: D1Database,
	input: {
		userId: string
		name: string
	},
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${savedPackageSelectColumns}
			FROM saved_packages
			WHERE name = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.name, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

/** The live saved package published from entity source `sourceId`. */
export async function getSavedPackageBySourceId(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
	},
): Promise<SavedPackageRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${savedPackageSelectColumns}
			FROM saved_packages
			WHERE source_id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.sourceId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapSavedPackageRow(row) : null
}

export async function listSavedPackagesByUserId(
	db: D1Database,
	input: {
		userId: string
	},
): Promise<Array<SavedPackageRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${savedPackageSelectColumns}
			FROM saved_packages
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY updated_at DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageRow)
}

export async function listSavedPackagesWithCommunityProvenanceByUserId(
	db: D1Database,
	input: {
		userId: string
	},
): Promise<Array<SavedPackageWithCommunityProvenanceRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${savedPackageCommunityProvenanceSelectColumns}
			FROM saved_packages
			${savedPackageCommunityProvenanceJoins}
			WHERE saved_packages.user_id = ?${andLiveDeletedAtSql('saved_packages')}
			ORDER BY saved_packages.updated_at DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageWithCommunityProvenanceRow)
}

export async function listSavedPackagesBySlugs(
	db: D1Database,
	input: {
		userId: string
		slugs: Array<string>
	},
): Promise<Array<SavedPackageRecord>> {
	if (input.slugs.length === 0) return []
	const uniqueSlugs = [...new Set(input.slugs)]
	const packages: Array<SavedPackageRecord> = []
	for (const slugChunk of chunkArray(uniqueSlugs, maxSqlBindingsPerChunk - 1)) {
		const placeholders = slugChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${savedPackageSelectColumns}
				FROM saved_packages
				WHERE user_id = ? AND ${savedPackageSlugSql} IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(input.userId, ...slugChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			packages.push(mapSavedPackageRow(row))
		}
	}
	return packages
}

export async function listSavedPackagesByIds(
	db: D1Database,
	input: {
		userId: string
		packageIds: Array<string>
	},
): Promise<Array<SavedPackageRecord>> {
	if (input.packageIds.length === 0) return []
	const uniquePackageIds = [...new Set(input.packageIds)]
	const packages: Array<SavedPackageRecord> = []
	for (const idChunk of chunkArray(
		uniquePackageIds,
		maxSqlBindingsPerChunk - 1,
	)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${savedPackageSelectColumns}
				FROM saved_packages
				WHERE user_id = ? AND id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(input.userId, ...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			packages.push(mapSavedPackageRow(row))
		}
	}
	return packages
}

export async function listSavedPackageCommunityProvenanceByIds(
	db: D1Database,
	input: {
		userId: string
		packageIds: Array<string>
	},
): Promise<Array<SavedPackageWithCommunityProvenanceRecord>> {
	if (input.packageIds.length === 0) return []
	const uniquePackageIds = [...new Set(input.packageIds)]
	const packages: Array<SavedPackageWithCommunityProvenanceRecord> = []
	for (const idChunk of chunkArray(
		uniquePackageIds,
		maxSqlBindingsPerChunk - 1,
	)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${savedPackageCommunityProvenanceSelectColumns}
				FROM saved_packages
				${savedPackageCommunityProvenanceJoins}
				WHERE saved_packages.user_id = ? AND saved_packages.id IN (${placeholders})${andLiveDeletedAtSql('saved_packages')}`,
			)
			.bind(input.userId, ...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			packages.push(mapSavedPackageWithCommunityProvenanceRow(row))
		}
	}
	return packages
}

export type SavedPackageSearchSort = 'updated' | 'created' | 'name'

/** Escape LIKE wildcards so user queries match literally. */
function savedPackageSearchOrderBy(sort: SavedPackageSearchSort) {
	switch (sort) {
		case 'updated':
			return 'updated_at DESC, id ASC'
		case 'created':
			return 'created_at DESC, id ASC'
		case 'name':
			return 'name COLLATE NOCASE ASC, id ASC'
		default:
			sort satisfies never
			throw new Error(`Unknown saved package sort: ${String(sort)}`)
	}
}

/**
 * Filtered, paged listing of one user's saved packages for browse UIs. The
 * query and count share the same WHERE clause so the reported total always
 * matches the filtered result set.
 */
export async function searchSavedPackagesByUserId(
	db: D1Database,
	input: {
		userId: string
		query?: string
		hasApp?: boolean | null
		sort?: SavedPackageSearchSort
		limit: number
		offset: number
	},
): Promise<{ items: Array<SavedPackageRecord>; total: number }> {
	const conditions = ['user_id = ?']
	const params: Array<unknown> = [input.userId]
	const query = input.query?.trim() ?? ''
	if (query) {
		const pattern = d1ContainsLikePattern(query.toLowerCase())
		conditions.push(
			`(LOWER(name) LIKE ? ESCAPE '\\'
				OR LOWER(kody_id) LIKE ? ESCAPE '\\'
				OR LOWER(description) LIKE ? ESCAPE '\\'
				OR LOWER(COALESCE(search_text, '')) LIKE ? ESCAPE '\\'
				OR LOWER(tags_json) LIKE ? ESCAPE '\\')`,
		)
		params.push(pattern, pattern, pattern, pattern, pattern)
	}
	if (input.hasApp != null) {
		conditions.push('has_app = ?')
		params.push(input.hasApp ? 1 : 0)
	}
	const whereClause = `WHERE ${conditions.join(' AND ')}`
	const orderBy = savedPackageSearchOrderBy(input.sort ?? 'updated')

	const [totalRow, rows] = await Promise.all([
		db
			.prepare(
				`SELECT COUNT(*) AS total FROM saved_packages ${whereClause}${andLiveDeletedAtSql()}`,
			)
			.bind(...params)
			.first<{ total: number }>(),
		db
			.prepare(
				`SELECT ${savedPackageSelectColumns}
				FROM saved_packages
				${whereClause}${andLiveDeletedAtSql()}
				ORDER BY ${orderBy}
				LIMIT ? OFFSET ?`,
			)
			.bind(...params, input.limit, input.offset)
			.all<Record<string, unknown>>(),
	])
	return {
		items: (rows.results ?? []).map(mapSavedPackageRow),
		total: totalRow?.total ?? 0,
	}
}

// Keyset-paged listing across all users, used by maintenance reindex so a
// single query never loads the whole table. Pass the last row id of the
// previous page (or null for the first page).
export async function listSavedPackagesPage(
	db: D1Database,
	input: {
		afterId: string | null
		limit: number
	},
): Promise<Array<SavedPackageRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${savedPackageSelectColumns}
			FROM saved_packages
			WHERE id > ?${andLiveDeletedAtSql()}
			ORDER BY id
			LIMIT ?`,
		)
		.bind(input.afterId ?? '', input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapSavedPackageRow)
}
