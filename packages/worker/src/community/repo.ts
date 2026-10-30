import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { d1ContainsLikePattern } from '#worker/d1-like-pattern.ts'
import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'
import { tokenizeSearchText } from '#worker/vectorize/scoring.ts'
import {
	emptyCommunityCategoryCounts,
	parseCommunityListingCategory,
	readStoredCommunityListingCategory,
	type CommunityCategoryCounts,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import { liveGrantForPersonSql } from '#worker/orgs/repo.ts'
import { CommunityForkClaimLostError } from './errors.ts'
import { normalizePackageManifestVersion } from './package-version.ts'
import {
	type CommunityActivityKind,
	type CommunityActivityRecord,
	type CommunityBanRecord,
	type CommunityBanRow,
	type CommunityForkRecord,
	type CommunityForkActor,
	type CommunityForkRow,
	type CommunityListingRecord,
	type CommunityListingRow,
	type CommunityListingStatus,
	type CommunityRatingAggregate,
	type CommunityRatingRecord,
	type CommunityRatingRow,
	type CommunityReportRecord,
	type CommunityReportRow,
	type CommunityReportStatus,
} from './types.ts'

export function mapCommunityListingRow(
	row: Record<string, unknown>,
): CommunityListingRecord {
	const pinnedCommit = String(row['pinned_commit'])
	const featuredAt =
		row['featured_at'] == null ? null : String(row['featured_at'])
	return {
		id: String(row['id']),
		ownerUserId: String(row['owner_user_id']) as OwnerId,
		packageId: String(row['package_id']),
		sourceId: String(row['source_id']),
		kodyId: String(row['kody_id']),
		name: String(row['name']),
		description: String(row['description']),
		tags: parseTagsJson(row['tags_json']),
		category: readStoredCommunityListingCategory(
			row['category'] == null ? null : String(row['category']),
		),
		searchText:
			row['search_text'] == null ? null : String(row['search_text']).trim(),
		readmeContent:
			row['readme_content'] == null ? null : String(row['readme_content']),
		license: String(row['license']),
		version:
			row['package_version'] == null
				? null
				: normalizePackageManifestVersion(String(row['package_version'])),
		pinnedCommit,
		iconCommit:
			row['source_published_commit'] == null
				? pinnedCommit
				: String(row['source_published_commit']),
		status: String(row['status']) as CommunityListingStatus,
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt,
		featured: featuredAt != null,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		publishedAt: String(row['published_at']),
	}
}

export const communityForkSelectColumns = `id, listing_id, forker_user_id, origin_commit, forked_package_id,
	forked_source_id, target_kody_id, created_at, adopted_at, adoption_note`

export function mapCommunityForkRow(
	row: Record<string, unknown>,
): CommunityForkRecord {
	return {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		forkerUserId: String(row['forker_user_id']),
		originCommit: String(row['origin_commit']),
		forkedPackageId: String(row['forked_package_id']),
		forkedSourceId: String(row['forked_source_id']),
		targetKodyId: String(row['target_kody_id']),
		createdAt: String(row['created_at']),
		adoptedAt: row['adopted_at'] == null ? null : String(row['adopted_at']),
		adoptionNote:
			row['adoption_note'] == null ? null : String(row['adoption_note']),
	}
}

function mapCommunityRatingRow(
	row: Record<string, unknown>,
): CommunityRatingRecord {
	return {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		userId: String(row['user_id']),
		stars: Number(row['stars']),
		adaptationEffort: Number(row['adaptation_effort']),
		note: row['note'] == null ? null : String(row['note']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapCommunityActivityRow(
	row: Record<string, unknown>,
): CommunityActivityRecord {
	const shared = {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		listingName: String(row['listing_name']),
		listingKodyId: String(row['listing_kody_id']),
		actingUsername:
			row['acting_username'] == null ? null : String(row['acting_username']),
		occurredAt: String(row['occurred_at']),
	}
	const kind = String(row['kind'])
	if (kind === 'fork') return { ...shared, kind }
	if (kind === 'rating') {
		return {
			...shared,
			kind,
			stars: Number(row['stars']),
			adaptationEffort: Number(row['adaptation_effort']),
		}
	}
	throw new Error(`Unsupported community activity kind: ${kind}`)
}

function mapCommunityReportRow(
	row: Record<string, unknown>,
): CommunityReportRecord {
	return {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		listingName: String(row['listing_name']),
		listingOwnerUserId: String(row['listing_owner_user_id']) as OwnerId,
		reporterUserId: String(row['reporter_user_id']) as OwnerId,
		reason: String(row['reason']),
		status: String(row['status']) as CommunityReportStatus,
		resolvedByUserId:
			row['resolved_by_user_id'] == null
				? null
				: String(row['resolved_by_user_id']),
		resolvedAt: row['resolved_at'] == null ? null : String(row['resolved_at']),
		resolutionNote:
			row['resolution_note'] == null ? null : String(row['resolution_note']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapCommunityBanRow(row: Record<string, unknown>): CommunityBanRecord {
	return {
		userId: String(row['user_id']),
		bannedByUserId: String(row['banned_by_user_id']),
		reason: String(row['reason']),
		createdAt: String(row['created_at']),
	}
}

function listingStatusFilter(includeDelisted: boolean) {
	if (includeDelisted) {
		return `WHERE 1=1${andLiveDeletedAtSql('community_listings')}`
	}
	return `WHERE community_listings.status = 'active'${andLiveDeletedAtSql('community_listings')}`
}

/**
 * Listing reads join the owner package's entity source so the icon commit
 * (`source_published_commit`) tracks the latest package publish. The join is
 * scoped to the listing owner + package so a foreign source row can never
 * leak a commit into another user's listing.
 */
export const communityListingSelectColumns = `community_listings.id, community_listings.owner_user_id,
	community_listings.package_id, community_listings.source_id, community_listings.kody_id,
	community_listings.name, community_listings.description, community_listings.tags_json,
	community_listings.category,
	community_listings.search_text, community_listings.readme_content, community_listings.license,
	community_listings.package_version,
	community_listings.pinned_commit, community_listings.status, community_listings.created_at,
	community_listings.updated_at, community_listings.published_at,
	community_listings.featured_at,
	entity_sources.published_commit AS source_published_commit`

export const communityListingSourceJoin = `LEFT JOIN entity_sources
	ON entity_sources.id = community_listings.source_id
	AND entity_sources.user_id = community_listings.owner_user_id
	AND entity_sources.entity_kind = 'package'
	AND entity_sources.entity_id = community_listings.package_id${andLiveDeletedAtSql('entity_sources')}`

// D1 caps bound parameters per statement, so IN (...) lookups over large id
// sets are issued in chunks (90 leaves headroom for fixed bindings).
const maxSqlBindingsPerChunk = 90

const communityActivityUnion = `SELECT
	community_forks.id AS id,
	'fork' AS kind,
	community_forks.listing_id AS listing_id,
	COALESCE(
		community_listings.name,
		community_forks.listing_name,
		'[deleted listing]'
	) AS listing_name,
	COALESCE(
		community_listings.kody_id,
		community_forks.listing_kody_id,
		'[unknown]'
	) AS listing_kody_id,
	users.username AS acting_username,
	community_forks.created_at AS occurred_at,
	NULL AS stars,
	NULL AS adaptation_effort
FROM community_forks
LEFT JOIN community_listings
	ON community_listings.id = community_forks.listing_id
LEFT JOIN users
	ON users.stable_user_id = community_forks.forker_user_id
UNION ALL
SELECT
	community_ratings.id AS id,
	'rating' AS kind,
	community_listings.id AS listing_id,
	community_listings.name AS listing_name,
	community_listings.kody_id AS listing_kody_id,
	users.username AS acting_username,
	community_ratings.updated_at AS occurred_at,
	community_ratings.stars AS stars,
	community_ratings.adaptation_effort AS adaptation_effort
FROM community_ratings
INNER JOIN community_listings
	ON community_listings.id = community_ratings.listing_id
LEFT JOIN users
	ON users.stable_user_id = community_ratings.user_id`

function buildCommunityActivityFilters(input: {
	kind?: CommunityActivityKind
	listingId?: string
}) {
	const filters: Array<string> = []
	const bindings: Array<unknown> = []
	if (input.kind !== undefined) {
		filters.push('activity.kind = ?')
		bindings.push(input.kind)
	}
	if (input.listingId !== undefined) {
		filters.push('activity.listing_id = ?')
		bindings.push(input.listingId)
	}
	return {
		where: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
		bindings,
	}
}

const communityListingSearchTextColumns = [
	'name',
	'kody_id',
	'description',
	'search_text',
	'tags_json',
	'readme_content',
] as const

const maxCommunityListingLikeTokens = 8
// Each token binds one LIKE per search column (6); 12 stays under D1's bound
// parameter limit and leaves room for camelCase parts.
const maxCommunityListingSearchTokens = 12

export function extractCommunityListingLikeTokens(
	query: string,
): Array<string> {
	// Tokens are restricted to [a-z0-9]+ so they are safe to embed inside
	// LIKE patterns without wildcard escaping.
	return Array.from(
		new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []),
	).slice(0, maxCommunityListingLikeTokens)
}

// Community search prefilter tokens: the same terms the search scorer uses,
// including camelCase parts, so "photoPortfolio" also prefilters on "photo"
// and "portfolio". Clauses are ORed, so extra parts only widen the read.
// [a-z0-9]+ only, safe inside LIKE patterns without escaping.
function extractCommunityListingSearchTokens(query: string): Array<string> {
	return Array.from(tokenizeSearchText(query)).slice(
		0,
		maxCommunityListingSearchTokens,
	)
}

export async function insertCommunityListing(
	db: D1Database,
	// New listings are never featured; featured_at starts NULL and is only
	// set through setCommunityListingFeaturedAt.
	row: Omit<
		CommunityListingRow,
		| 'created_at'
		| 'updated_at'
		| 'published_at'
		| 'featured_at'
		| 'package_version'
	> & {
		created_at?: string
		updated_at?: string
		published_at?: string
		package_version?: string | null
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO community_listings (
				id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, category, search_text, readme_content, license, package_version,
				pinned_commit, status,
				created_at, updated_at, published_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.owner_user_id,
			row.package_id,
			row.source_id,
			row.kody_id,
			row.name,
			row.description,
			row.tags_json,
			row.category,
			row.search_text ?? null,
			row.readme_content ?? null,
			row.license,
			row.package_version ?? null,
			row.pinned_commit,
			row.status,
			row.created_at ?? now,
			row.updated_at ?? now,
			row.published_at ?? now,
		)
		.run()
}

export async function updateCommunityListing(
	db: D1Database,
	input: {
		listingId: string
		ownerUserId: string
		sourceId?: string
		kodyId?: string
		name?: string
		description?: string
		tagsJson?: string
		category?: CommunityListingRecord['category']
		searchText?: string | null
		readmeContent?: string | null
		license?: string
		packageVersion?: string | null
		pinnedCommit?: string
		status?: CommunityListingStatus
		publishedAt?: string
		requireStatus?: CommunityListingStatus
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []

	function addAssignment(column: string, value: unknown) {
		assignments.push(`${column} = ?`)
		values.push(value)
	}

	if (input.sourceId !== undefined) addAssignment('source_id', input.sourceId)
	if (input.kodyId !== undefined) addAssignment('kody_id', input.kodyId)
	if (input.name !== undefined) addAssignment('name', input.name)
	if (input.description !== undefined) {
		addAssignment('description', input.description)
	}
	if (input.tagsJson !== undefined) addAssignment('tags_json', input.tagsJson)
	if (input.category !== undefined) addAssignment('category', input.category)
	if (input.searchText !== undefined) {
		addAssignment('search_text', input.searchText ?? null)
	}
	if (input.readmeContent !== undefined) {
		addAssignment('readme_content', input.readmeContent ?? null)
	}
	if (input.license !== undefined) addAssignment('license', input.license)
	if (input.packageVersion !== undefined) {
		addAssignment('package_version', input.packageVersion)
	}
	if (input.pinnedCommit !== undefined) {
		addAssignment('pinned_commit', input.pinnedCommit)
	}
	if (input.status !== undefined) addAssignment('status', input.status)
	if (input.publishedAt !== undefined) {
		addAssignment('published_at', input.publishedAt)
	}
	addAssignment('updated_at', new Date().toISOString())

	const statusClause = input.requireStatus != null ? ' AND status = ?' : ''
	const statusBindings =
		input.requireStatus != null ? [input.requireStatus] : []

	const result = await db
		.prepare(
			`UPDATE community_listings
			SET ${assignments.join(', ')}
			WHERE id = ? AND owner_user_id = ?${statusClause}${andLiveDeletedAtSql()}`,
		)
		.bind(...values, input.listingId, input.ownerUserId, ...statusBindings)
		.run()

	return (result.meta.changes ?? 0) > 0
}

export async function getCommunityListingById(
	db: D1Database,
	input: {
		listingId: string
		includeDelisted: boolean
	},
): Promise<CommunityListingRecord | null> {
	const statusClause = input.includeDelisted
		? ''
		: `AND community_listings.status = 'active'`
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.id = ? ${statusClause}${andLiveDeletedAtSql('community_listings')}`,
		)
		.bind(input.listingId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityListingRow(row) : null
}

/**
 * Same visibility and owner-source join as `getCommunityListingById`, for a
 * set of ids. Unknown ids are omitted. Results follow `listingIds` order
 * (first occurrence wins if an id is repeated).
 */
export async function getCommunityListingsByIds(
	db: D1Database,
	input: {
		listingIds: Array<string>
		includeDelisted: boolean
	},
): Promise<Array<CommunityListingRecord>> {
	if (input.listingIds.length === 0) return []
	const uniqueIds = [...new Set(input.listingIds)]
	const statusClause = input.includeDelisted
		? ''
		: `AND community_listings.status = 'active'`
	const byId = new Map<string, CommunityListingRecord>()
	for (const idChunk of chunkArray(uniqueIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${communityListingSelectColumns}
				FROM community_listings
				${communityListingSourceJoin}
				WHERE community_listings.id IN (${placeholders}) ${statusClause}${andLiveDeletedAtSql('community_listings')}`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			const listing = mapCommunityListingRow(row)
			byId.set(listing.id, listing)
		}
	}
	const ordered: Array<CommunityListingRecord> = []
	const seen = new Set<string>()
	for (const listingId of input.listingIds) {
		if (seen.has(listingId)) continue
		seen.add(listingId)
		const listing = byId.get(listingId)
		if (listing) ordered.push(listing)
	}
	return ordered
}

export async function getActiveCommunityListingWithPublisherUsername(
	db: D1Database,
	input: { listingId: string },
): Promise<{
	listing: CommunityListingRecord
	publisherUsername: string | null
} | null> {
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns},
				users.username AS publisher_username
			FROM community_listings
			${communityListingSourceJoin}
			LEFT JOIN users ON users.stable_user_id = community_listings.owner_user_id
			WHERE community_listings.id = ?
				AND community_listings.status = 'active'${andLiveDeletedAtSql('community_listings')}
				AND users.deleted_at IS NULL`,
		)
		.bind(input.listingId)
		.first<Record<string, unknown>>()
	if (!row) return null
	return {
		listing: mapCommunityListingRow(row),
		publisherUsername:
			row['publisher_username'] == null
				? null
				: String(row['publisher_username']).trim() || null,
	}
}

export async function getCommunityListingByOwnerAndPackage(
	db: D1Database,
	input: {
		ownerUserId: string
		packageId: string
	},
): Promise<CommunityListingRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.owner_user_id = ? AND community_listings.package_id = ?${andLiveDeletedAtSql('community_listings')}`,
		)
		.bind(input.ownerUserId, input.packageId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityListingRow(row) : null
}

/**
 * Active catalog rows whose pin lags the package runtime `published_commit`.
 * Used by the one-shot listing-behind backfill after auto-follow landed.
 */
export async function listActiveCommunityListingsBehindPublished(
	db: D1Database,
	input: { limit: number },
): Promise<
	Array<{
		listing: CommunityListingRecord
		publishedCommit: string
	}>
> {
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns},
				entity_sources.published_commit AS source_published_commit
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.status = 'active'
				AND entity_sources.published_commit IS NOT NULL
				AND TRIM(entity_sources.published_commit) != ''
				AND community_listings.pinned_commit != entity_sources.published_commit
				${andLiveDeletedAtSql('community_listings')}
			ORDER BY community_listings.updated_at ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).flatMap((row) => {
		const publishedCommit = String(row['source_published_commit'] ?? '').trim()
		if (!publishedCommit) return []
		return [
			{
				listing: mapCommunityListingRow(row),
				publishedCommit,
			},
		]
	})
}

/**
 * Lookup behind the canonical `/@owner/kody-id` URL. Only active listings are
 * addressable that way: a delisted listing releases the pair (and the partial
 * unique index that guards it), so a republish can take the URL over.
 */
export async function getCommunityListingByOwnerAndKodyId(
	db: D1Database,
	input: {
		ownerUserId: string
		kodyId: string
	},
): Promise<CommunityListingRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.owner_user_id = ?
				AND community_listings.kody_id = ?
				AND community_listings.status = 'active'${andLiveDeletedAtSql('community_listings')}`,
		)
		.bind(input.ownerUserId, input.kodyId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityListingRow(row) : null
}

export async function listCommunityListings(
	db: D1Database,
	input: {
		includeDelisted: boolean
		limit: number
		offset: number
	},
): Promise<Array<CommunityListingRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			${listingStatusFilter(input.includeDelisted)}${andLiveDeletedAtSql('community_listings')}
			ORDER BY community_listings.published_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(input.limit, input.offset)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

export async function countActiveCommunityListingsByCategory(
	db: D1Database,
): Promise<CommunityCategoryCounts> {
	const rows = await db
		.prepare(
			`SELECT category, COUNT(*) AS listing_count
			FROM community_listings
			WHERE status = 'active'${andLiveDeletedAtSql()}
			GROUP BY category`,
		)
		.all<{ category: string; listing_count: number }>()
	const counts = emptyCommunityCategoryCounts()
	for (const row of rows.results ?? []) {
		const category = parseCommunityListingCategory(row.category)
		if (category == null) continue
		counts[category] = Number(row.listing_count)
	}
	return counts
}

/**
 * Bounded candidate query for community search/browse. Applies SQL-level text
 * pre-filtering (LIKE across name/kody_id/description/search_text/tags_json/
 * readme_content) when a query is provided, orders by recency, and never
 * returns more than `limit` rows so scoring stays off the full table.
 * Stored `category` is applied in SQL so a filtered browse is not capped by
 * the global newest-N window.
 */
export async function listCommunityListingCandidates(
	db: D1Database,
	input: {
		includeDelisted: boolean
		limit: number
		offset?: number
		query?: string | null
		category?: CommunityListingCategory | null
	},
): Promise<Array<CommunityListingRecord>> {
	const conditions: Array<string> = [
		'community_listings.deleted_at IS NULL',
		'(entity_sources.id IS NULL OR entity_sources.deleted_at IS NULL)',
	]
	const bindings: Array<unknown> = []
	if (!input.includeDelisted) {
		conditions.push(`community_listings.status = 'active'`)
	}
	if (input.category != null) {
		conditions.push(`community_listings.category = ?`)
		bindings.push(input.category)
	}
	const tokens = extractCommunityListingSearchTokens(input.query ?? '')
	if (tokens.length > 0) {
		const tokenClauses = tokens.map((token) => {
			const pattern = d1ContainsLikePattern(token, { escape: false })
			const columnClauses = communityListingSearchTextColumns.map((column) => {
				bindings.push(pattern)
				return `community_listings.${column} LIKE ?`
			})
			return `(${columnClauses.join(' OR ')})`
		})
		conditions.push(`(${tokenClauses.join(' OR ')})`)
	}
	const whereClause =
		conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			${whereClause}${andLiveDeletedAtSql('community_listings')}
			ORDER BY community_listings.published_at DESC, community_listings.id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...bindings, input.limit, input.offset ?? 0)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

/**
 * Unfiltered `/community` overview candidates: one windowed read of the
 * newest `limitPerCategory` active listings per category. Optional
 * `categories` keeps the window on populated shelves only.
 */
export async function listCommunityIndexOverviewCandidates(
	db: D1Database,
	input: {
		limitPerCategory: number
		categories?: ReadonlyArray<CommunityListingCategory>
	},
): Promise<Array<CommunityListingRecord>> {
	const categories = input.categories ?? []
	const categoryFilter =
		categories.length > 0
			? `AND community_listings.category IN (${categories.map(() => '?').join(', ')})`
			: ''
	const rows = await db
		.prepare(
			`WITH ranked AS (
				SELECT
					id,
					ROW_NUMBER() OVER (
						PARTITION BY category
						ORDER BY published_at DESC
					) AS category_rank
				FROM community_listings
				WHERE status = 'active'
					AND deleted_at IS NULL
					${categoryFilter}
			)
			SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			INNER JOIN ranked
				ON ranked.id = community_listings.id
			WHERE ranked.category_rank <= ?
			ORDER BY community_listings.published_at DESC`,
		)
		.bind(...categories, input.limitPerCategory)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

export async function deleteCommunityListing(
	db: D1Database,
	input: {
		listingId: string
		ownerUserId?: string
	},
): Promise<boolean> {
	const ownerClause = input.ownerUserId != null ? 'AND owner_user_id = ?' : ''
	const bindings =
		input.ownerUserId != null
			? [input.listingId, input.ownerUserId]
			: [input.listingId]
	const result = await db
		.prepare(
			`DELETE FROM community_listings WHERE id = ? ${ownerClause}${andLiveDeletedAtSql()}`,
		)
		.bind(...bindings)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function setCommunityListingFeaturedAt(
	db: D1Database,
	input: {
		listingId: string
		featured: boolean
	},
): Promise<boolean> {
	const now = new Date().toISOString()
	// Re-featuring keeps the original timestamp (COALESCE) so idempotent
	// retries never reshuffle the featured_at-ordered onboarding list.
	const result = await db
		.prepare(
			`UPDATE community_listings
			SET featured_at = CASE WHEN ? THEN COALESCE(featured_at, ?) ELSE NULL END,
				updated_at = ?
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.featured ? 1 : 0, now, now, input.listingId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Listings that should be offered as onboarding starter packages: featured
 * by an admin. Ordered by when they were featured so the curated order
 * stays stable as new packages are added.
 */
export async function listFeaturedCommunityListings(
	db: D1Database,
	input: {
		limit: number
	},
): Promise<Array<CommunityListingRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.status = 'active'
				AND community_listings.featured_at IS NOT NULL${andLiveDeletedAtSql('community_listings')}
			ORDER BY community_listings.featured_at ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

export async function setCommunityListingStatus(
	db: D1Database,
	input: {
		listingId: string
		status: CommunityListingStatus
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE community_listings
			SET status = ?, updated_at = ?
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.status, new Date().toISOString(), input.listingId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertCommunityFork(
	db: D1Database,
	row: Omit<
		CommunityForkRow,
		'created_at' | 'adopted_at' | 'adoption_note' | 'actor'
	> & {
		listing_name: string
		listing_kody_id: string
		created_at?: string
		actor?: CommunityForkActor | null
		/**
		 * When set, the insert only succeeds while this claim still holds
		 * `(forker_user_id, listing_id)`. A lost lease inserts zero rows and
		 * throws {@link CommunityForkClaimLostError}, so a raced create cannot
		 * write a duplicate after takeover.
		 */
		claim_id?: string | null
	},
): Promise<void> {
	const createdAt = row.created_at ?? new Date().toISOString()
	const claimId = row.claim_id?.trim() || null
	if (claimId) {
		// Lease check uses a fresh clock sample, not createdAt: an older
		// created_at (or delay before this statement) must not treat an
		// expired claim as still live.
		const leaseNow = new Date().toISOString()
		const result = await db
			.prepare(
				`INSERT INTO community_forks (
					id, listing_id, forker_user_id, origin_commit, forked_package_id,
					forked_source_id, target_kody_id, listing_name, listing_kody_id,
					created_at, actor
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE EXISTS (
					SELECT 1 FROM community_fork_claims
					WHERE owner_id = ?
						AND listing_id = ?
						AND claim_id = ?
						AND expires_at > ?
				)`,
			)
			.bind(
				row.id,
				row.listing_id,
				row.forker_user_id,
				row.origin_commit,
				row.forked_package_id,
				row.forked_source_id,
				row.target_kody_id,
				row.listing_name,
				row.listing_kody_id,
				createdAt,
				row.actor ?? null,
				row.forker_user_id,
				row.listing_id,
				claimId,
				leaseNow,
			)
			.run()
		if ((result.meta.changes ?? 0) === 0) {
			throw new CommunityForkClaimLostError()
		}
		return
	}
	await db
		.prepare(
			`INSERT INTO community_forks (
				id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, listing_name, listing_kody_id,
				created_at, actor
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.forker_user_id,
			row.origin_commit,
			row.forked_package_id,
			row.forked_source_id,
			row.target_kody_id,
			row.listing_name,
			row.listing_kody_id,
			createdAt,
			row.actor ?? null,
		)
		.run()
}

export async function deleteCommunityForksForPackage(
	db: D1Database,
	input: {
		userId: string
		packageId: string
		sourceId?: string
	},
): Promise<number> {
	const result = input.sourceId
		? await db
				.prepare(
					`DELETE FROM community_forks
					WHERE forker_user_id = ?
						AND (forked_package_id = ? OR forked_source_id = ?)`,
				)
				.bind(input.userId, input.packageId, input.sourceId)
				.run()
		: await db
				.prepare(
					`DELETE FROM community_forks
					WHERE forker_user_id = ?
						AND forked_package_id = ?`,
				)
				.bind(input.userId, input.packageId)
				.run()
	return result.meta.changes ?? 0
}

export type OrphanedCommunityForkRow = {
	id: string
	listing_id: string
	listing_name: string | null
	listing_kody_id: string | null
	forker_user_id: string
	forked_package_id: string
	forked_source_id: string
	target_kody_id: string
	created_at: string
}

/**
 * Fork rows whose inert source and saved package are both gone. Healthy
 * community forks stay inert (no `saved_packages` row) and keep an
 * `entity_sources` row, so a missing package alone is not an orphan.
 */
export async function listOrphanedCommunityForks(
	db: D1Database,
	input: {
		forkIds?: Array<string>
	} = {},
): Promise<Array<OrphanedCommunityForkRow>> {
	const uniqueForkIds = [...new Set(input.forkIds ?? [])]
	if (input.forkIds !== undefined && uniqueForkIds.length === 0) return []
	const orphans: Array<OrphanedCommunityForkRow> = []
	const idChunks =
		uniqueForkIds.length === 0
			? [[] as Array<string>]
			: chunkArray(uniqueForkIds, maxSqlBindingsPerChunk)
	for (const idChunk of idChunks) {
		const idFilter =
			idChunk.length > 0
				? `AND community_forks.id IN (${idChunk.map(() => '?').join(', ')})`
				: ''
		const rows = await db
			.prepare(
				`SELECT community_forks.id AS id,
					community_forks.listing_id AS listing_id,
					community_forks.listing_name AS listing_name,
					community_forks.listing_kody_id AS listing_kody_id,
					community_forks.forker_user_id AS forker_user_id,
					community_forks.forked_package_id AS forked_package_id,
					community_forks.forked_source_id AS forked_source_id,
					community_forks.target_kody_id AS target_kody_id,
					community_forks.created_at AS created_at
				FROM community_forks
				WHERE NOT EXISTS (
					SELECT 1
					FROM entity_sources
					WHERE entity_sources.id = community_forks.forked_source_id
				)
				AND NOT EXISTS (
					SELECT 1
					FROM saved_packages
					WHERE saved_packages.id = community_forks.forked_package_id
						AND saved_packages.deleted_at IS NULL
				)
				${idFilter}
				ORDER BY community_forks.created_at ASC`,
			)
			.bind(...idChunk)
			.all<OrphanedCommunityForkRow>()
		orphans.push(...(rows.results ?? []))
	}
	return orphans
}

export async function deleteCommunityForksByIds(
	db: D1Database,
	forkIds: Array<string>,
): Promise<number> {
	const uniqueForkIds = [...new Set(forkIds)]
	if (uniqueForkIds.length === 0) return 0
	let deleted = 0
	for (const idChunk of chunkArray(uniqueForkIds, maxSqlBindingsPerChunk)) {
		const result = await db
			.prepare(
				`DELETE FROM community_forks
				WHERE id IN (${idChunk.map(() => '?').join(', ')})`,
			)
			.bind(...idChunk)
			.run()
		deleted += result.meta.changes ?? 0
	}
	return deleted
}

export async function repointOrphanedCommunityForksToListing(
	db: D1Database,
	input: {
		listingId: string
		listingName: string
		listingKodyId: string
	},
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE community_forks
			SET listing_id = ?
			WHERE listing_id != ?
				AND listing_name = ?
				AND listing_kody_id = ?
				AND NOT EXISTS (
					SELECT 1
					FROM community_listings
					WHERE community_listings.id = community_forks.listing_id
						${andLiveDeletedAtSql('community_listings')}
				)`,
		)
		.bind(
			input.listingId,
			input.listingId,
			input.listingName,
			input.listingKodyId,
		)
		.run()
	return result.meta.changes ?? 0
}

export async function getCommunityForkByListingAndUser(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<CommunityForkRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE listing_id = ? AND forker_user_id = ?`,
		)
		.bind(input.listingId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityForkRow(row) : null
}

export async function getCommunityForkByForkedPackageId(
	db: D1Database,
	input: {
		forkerUserId: string
		forkedPackageId: string
	},
): Promise<CommunityForkRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE forked_package_id = ? AND forker_user_id = ?`,
		)
		.bind(input.forkedPackageId, input.forkerUserId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityForkRow(row) : null
}

export async function updateCommunityForkOriginCommit(
	db: D1Database,
	input: {
		forkerUserId: string
		forkedPackageId: string
		originCommit: string
	},
): Promise<CommunityForkRecord | null> {
	const result = await db
		.prepare(
			`UPDATE community_forks
			SET origin_commit = ?
			WHERE forked_package_id = ? AND forker_user_id = ?`,
		)
		.bind(input.originCommit, input.forkedPackageId, input.forkerUserId)
		.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return getCommunityForkByForkedPackageId(db, {
		forkerUserId: input.forkerUserId,
		forkedPackageId: input.forkedPackageId,
	})
}

export async function markCommunityForkAdopted(
	db: D1Database,
	input: {
		forkerUserId: string
		forkedPackageId: string
		adoptionNote: string
		adoptedAt: string
	},
): Promise<CommunityForkRecord | null> {
	const result = await db
		.prepare(
			`UPDATE community_forks
			SET adopted_at = ?, adoption_note = ?
			WHERE forked_package_id = ? AND forker_user_id = ?
				AND adopted_at IS NULL`,
		)
		.bind(
			input.adoptedAt,
			input.adoptionNote,
			input.forkedPackageId,
			input.forkerUserId,
		)
		.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return getCommunityForkByForkedPackageId(db, {
		forkerUserId: input.forkerUserId,
		forkedPackageId: input.forkedPackageId,
	})
}

export async function listCommunityForksByListingAndUser(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<Array<CommunityForkRecord>> {
	const result = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE listing_id = ? AND forker_user_id = ?
			ORDER BY created_at ASC`,
		)
		.bind(input.listingId, input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map((row) => mapCommunityForkRow(row))
}

export async function listCommunityForksByListingId(
	db: D1Database,
	input: { listingId: string },
): Promise<Array<CommunityForkRecord>> {
	const result = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE listing_id = ?
			ORDER BY created_at ASC`,
		)
		.bind(input.listingId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map((row) => mapCommunityForkRow(row))
}

/**
 * Viewer forks for a set of listings. `ORDER BY created_at` applies inside
 * each D1 chunk only; callers that need a global order must sort themselves.
 */
export async function listCommunityForksByListingIdsAndUser(
	db: D1Database,
	input: {
		listingIds: Array<string>
		userId: string
	},
): Promise<Array<CommunityForkRecord>> {
	if (input.listingIds.length === 0) return []
	const uniqueListingIds = [...new Set(input.listingIds)]
	const forks: Array<CommunityForkRecord> = []
	for (const idChunk of chunkArray(
		uniqueListingIds,
		maxSqlBindingsPerChunk - 1,
	)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${communityForkSelectColumns}
				FROM community_forks
				WHERE forker_user_id = ? AND listing_id IN (${placeholders})
				ORDER BY created_at ASC`,
			)
			.bind(input.userId, ...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			forks.push(mapCommunityForkRow(row))
		}
	}
	return forks
}

/**
 * A fork is listable once its saved package is live in an active org. Inert
 * forks (no saved package yet) never count.
 */
const communityForkPackageJoinSql = `INNER JOIN saved_packages AS sp
	ON sp.id = f.forked_package_id
	AND sp.user_id = f.forker_user_id${andLiveDeletedAtSql('sp')}
INNER JOIN orgs AS o
	ON o.id = sp.user_id${andActiveOrgSql('o')}`

/** Anyone may see a fork whose package is neither private nor hidden. */
const publicCommunityForkSql = 'sp.is_private = 0 AND sp.hidden = 0'

/**
 * Public fork counts only. Private or hidden fork copies stay out so the
 * public number never reveals them; viewers who can read a private fork get
 * it added on top (`loadViewerPrivateCommunityForks`).
 */
export async function countCommunityForksByListingIds(
	db: D1Database,
	listingIds: Array<string>,
): Promise<Record<string, number>> {
	if (listingIds.length === 0) return {}
	const counts: Record<string, number> = Object.fromEntries(
		listingIds.map((listingId) => [listingId, 0]),
	)
	for (const idChunk of chunkArray(listingIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT f.listing_id AS listing_id, COUNT(*) AS fork_count
				FROM community_forks AS f
				${communityForkPackageJoinSql}
				WHERE f.listing_id IN (${placeholders})
					AND ${publicCommunityForkSql}
				GROUP BY f.listing_id`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			counts[String(row['listing_id'])] = Number(row['fork_count'] ?? 0)
		}
	}
	return counts
}

export type CommunityForkListRow = {
	forkId: string
	createdAt: string
	packageId: string
	kodyId: string
	description: string
	isPrivate: boolean
	ownerId: string
	ownerSlug: string
	ownerDisplayName: string | null
	ownerAvatarKey: string | null
	publishedCommit: string | null
}

const communityForkListSelectSql = `SELECT f.id AS fork_id, f.created_at AS created_at,
	sp.id AS package_id, sp.kody_id AS kody_id, sp.description AS description,
	sp.is_private AS is_private, sp.hidden AS hidden, sp.user_id AS owner_id,
	o.slug AS owner_slug, o.display_name AS owner_display_name,
	o.avatar_key AS owner_avatar_key, es.published_commit AS published_commit
FROM community_forks AS f
${communityForkPackageJoinSql}
LEFT JOIN entity_sources AS es
	ON es.id = sp.source_id
	AND es.user_id = sp.user_id${andLiveDeletedAtSql('es')}`

function mapCommunityForkListRow(
	row: Record<string, unknown>,
): CommunityForkListRow {
	return {
		forkId: String(row['fork_id']),
		createdAt: String(row['created_at']),
		packageId: String(row['package_id']),
		kodyId: String(row['kody_id']),
		description: String(row['description'] ?? ''),
		isPrivate: Number(row['is_private']) === 1 || Number(row['hidden']) === 1,
		ownerId: String(row['owner_id']),
		ownerSlug: String(row['owner_slug']),
		ownerDisplayName:
			row['owner_display_name'] == null
				? null
				: String(row['owner_display_name']),
		ownerAvatarKey:
			row['owner_avatar_key'] == null ? null : String(row['owner_avatar_key']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
	}
}

/** Newest public forks of a listing (same predicate as the public count). */
export async function listPublicCommunityForks(
	db: D1Database,
	input: { listingId: string; limit: number },
): Promise<Array<CommunityForkListRow>> {
	const rows = await db
		.prepare(
			`${communityForkListSelectSql}
			WHERE f.listing_id = ? AND ${publicCommunityForkSql}
			ORDER BY f.created_at DESC, f.id ASC
			LIMIT ?`,
		)
		.bind(input.listingId, input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityForkListRow)
}

/**
 * Private or hidden forks in orgs the person belongs to or holds a grant in.
 * Only a candidate set: callers must still check `package:read` per fork.
 */
export async function listPrivateCommunityForkCandidatesForPerson(
	db: D1Database,
	input: { listingId: string; personId: string },
): Promise<Array<CommunityForkListRow>> {
	const liveGrant = liveGrantForPersonSql('sp.user_id', input.personId)
	const rows = await db
		.prepare(
			`${communityForkListSelectSql}
			WHERE f.listing_id = ?
				AND NOT (${publicCommunityForkSql})
				AND (
					EXISTS (
						SELECT 1 FROM org_memberships AS m
						WHERE m.org_id = sp.user_id
							AND m.user_id = ?
							AND m.deleted_at IS NULL
					)
					OR EXISTS (${liveGrant.sql})
				)
			ORDER BY f.created_at DESC, f.id ASC`,
		)
		.bind(input.listingId, input.personId, ...liveGrant.binds)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityForkListRow)
}

export async function listCommunityActivityRowsForAdmin(
	db: D1Database,
	input: {
		page: number
		pageSize: number
		kind?: CommunityActivityKind
		listingId?: string
	},
): Promise<{
	total: number
	items: Array<CommunityActivityRecord>
}> {
	const filters = buildCommunityActivityFilters(input)
	const count = await db
		.prepare(
			`SELECT COUNT(*) AS total
			FROM (${communityActivityUnion}) AS activity
			${filters.where}`,
		)
		.bind(...filters.bindings)
		.first<{ total: number }>()
	const items = await listCommunityActivityPageRowsForAdmin(db, input)
	return { total: Number(count?.total ?? 0), items }
}

export async function listCommunityActivityPageRowsForAdmin(
	db: D1Database,
	input: {
		page: number
		pageSize: number
		kind?: CommunityActivityKind
		listingId?: string
	},
): Promise<Array<CommunityActivityRecord>> {
	const filters = buildCommunityActivityFilters(input)
	const result = await db
		.prepare(
			`SELECT activity.*
			FROM (${communityActivityUnion}) AS activity
			${filters.where}
			ORDER BY activity.occurred_at DESC, activity.id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(
			...filters.bindings,
			input.pageSize,
			(input.page - 1) * input.pageSize,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapCommunityActivityRow)
}

export async function getCommunityActivityByIdForAdmin(
	db: D1Database,
	input: { kind: CommunityActivityKind; activityId: string },
): Promise<CommunityActivityRecord | null> {
	const row = await db
		.prepare(
			`SELECT activity.*
			FROM (${communityActivityUnion}) AS activity
			WHERE activity.kind = ? AND activity.id = ?`,
		)
		.bind(input.kind, input.activityId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityActivityRow(row) : null
}

export async function upsertCommunityRating(
	db: D1Database,
	row: Omit<CommunityRatingRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<CommunityRatingRecord> {
	const now = new Date().toISOString()
	const persisted = await db
		.prepare(
			`INSERT INTO community_ratings (
				id, listing_id, user_id, stars, adaptation_effort, note, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(listing_id, user_id) DO UPDATE SET
				stars = excluded.stars,
				adaptation_effort = excluded.adaptation_effort,
				note = excluded.note,
				updated_at = excluded.updated_at
			RETURNING id, listing_id, user_id, stars, adaptation_effort, note,
				created_at, updated_at`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.user_id,
			row.stars,
			row.adaptation_effort,
			row.note ?? null,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.first<Record<string, unknown>>()
	if (!persisted) {
		throw new Error('Community rating upsert did not return a row.')
	}
	return mapCommunityRatingRow(persisted)
}

export async function deleteCommunityRatingsByListingId(
	db: D1Database,
	listingId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_ratings WHERE listing_id = ?`)
		.bind(listingId)
		.run()
}

export async function getCommunityRatingAggregatesByListingId(
	db: D1Database,
	listingId: string,
): Promise<CommunityRatingAggregate> {
	const row = await db
		.prepare(
			`SELECT
				COUNT(*) AS rating_count,
				AVG(stars) AS average_stars,
				AVG(adaptation_effort) AS average_adaptation_effort
			FROM community_ratings
			WHERE listing_id = ?`,
		)
		.bind(listingId)
		.first<Record<string, unknown>>()
	const ratingCount = Number(row?.['rating_count'] ?? 0)
	return {
		listingId,
		ratingCount,
		averageStars:
			ratingCount === 0 ? null : Number(row?.['average_stars'] ?? 0),
		averageAdaptationEffort:
			ratingCount === 0
				? null
				: Number(row?.['average_adaptation_effort'] ?? 0),
	}
}

export async function getCommunityRatingAggregatesByListingIds(
	db: D1Database,
	listingIds: Array<string>,
): Promise<Record<string, CommunityRatingAggregate>> {
	if (listingIds.length === 0) return {}
	const aggregates: Record<string, CommunityRatingAggregate> =
		Object.fromEntries(
			listingIds.map((listingId) => [
				listingId,
				{
					listingId,
					ratingCount: 0,
					averageStars: null,
					averageAdaptationEffort: null,
				},
			]),
		)
	for (const idChunk of chunkArray(listingIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT
					listing_id,
					COUNT(*) AS rating_count,
					AVG(stars) AS average_stars,
					AVG(adaptation_effort) AS average_adaptation_effort
				FROM community_ratings
				WHERE listing_id IN (${placeholders})
				GROUP BY listing_id`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			const listingId = String(row['listing_id'])
			const ratingCount = Number(row['rating_count'] ?? 0)
			aggregates[listingId] = {
				listingId,
				ratingCount,
				averageStars:
					ratingCount === 0 ? null : Number(row['average_stars'] ?? 0),
				averageAdaptationEffort:
					ratingCount === 0
						? null
						: Number(row['average_adaptation_effort'] ?? 0),
			}
		}
	}
	return aggregates
}

export async function insertCommunityReport(
	db: D1Database,
	row: Omit<CommunityReportRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO community_reports (
				id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
				reason, status, resolved_by_user_id, resolved_at, resolution_note,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.listing_name,
			row.listing_owner_user_id,
			row.reporter_user_id,
			row.reason,
			row.status,
			row.resolved_by_user_id ?? null,
			row.resolved_at ?? null,
			row.resolution_note ?? null,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function listCommunityReports(
	db: D1Database,
	input: {
		status?: CommunityReportStatus
	},
): Promise<Array<CommunityReportRecord>> {
	const statusClause = input.status != null ? 'WHERE status = ?' : ''
	const bindings = input.status != null ? [input.status] : []
	const rows = await db
		.prepare(
			`SELECT id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
				reason, status, resolved_by_user_id, resolved_at, resolution_note,
				created_at, updated_at
			FROM community_reports
			${statusClause}
			ORDER BY created_at DESC`,
		)
		.bind(...bindings)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityReportRow)
}

export async function getCommunityReportById(
	db: D1Database,
	reportId: string,
): Promise<CommunityReportRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
				reason, status, resolved_by_user_id, resolved_at, resolution_note,
				created_at, updated_at
			FROM community_reports
			WHERE id = ?`,
		)
		.bind(reportId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityReportRow(row) : null
}

export async function resolveCommunityReportRow(
	db: D1Database,
	input: {
		reportId: string
		status: Exclude<CommunityReportStatus, 'open'>
		resolvedByUserId: string
		resolutionNote?: string | null
	},
): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await db
		.prepare(
			`UPDATE community_reports
			SET status = ?, resolved_by_user_id = ?, resolved_at = ?, resolution_note = ?,
				updated_at = ?
			WHERE id = ? AND status = 'open'`,
		)
		.bind(
			input.status,
			input.resolvedByUserId,
			now,
			input.resolutionNote ?? null,
			now,
			input.reportId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertCommunityBan(
	db: D1Database,
	row: Omit<CommunityBanRow, 'created_at'> & { created_at?: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO community_bans (user_id, banned_by_user_id, reason, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				banned_by_user_id = excluded.banned_by_user_id,
				reason = excluded.reason,
				created_at = excluded.created_at`,
		)
		.bind(
			row.user_id,
			row.banned_by_user_id,
			row.reason,
			row.created_at ?? new Date().toISOString(),
		)
		.run()
}

export async function deleteCommunityBan(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM community_bans WHERE user_id = ?`)
		.bind(userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getCommunityBan(
	db: D1Database,
	userId: string,
): Promise<CommunityBanRecord | null> {
	const row = await db
		.prepare(
			`SELECT user_id, banned_by_user_id, reason, created_at
			FROM community_bans
			WHERE user_id = ?`,
		)
		.bind(userId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityBanRow(row) : null
}
