import { d1ContainsLikePattern } from '#worker/d1-like-pattern.ts'
import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import { listingNeedsRepublish } from './listing-needs-republish.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { extractCommunityListingLikeTokens } from './repo.ts'
import {
	type CommunityActivityEventType,
	type CommunityActivityItem,
	type ProfileVisibility,
	type PublicProfilePackageListRow,
} from './types.ts'

// D1 caps bound parameters per statement; 90 leaves headroom for fixed binds.
const maxSqlBindingsPerChunk = 90

export type UserSocialRow = {
	id: number
	username: string
	email: string
	stable_user_id: string
	personal_org_id: string | null
	display_name: string | null
	bio: string | null
	avatar_key: string | null
	profile_visibility: ProfileVisibility
	created_at: string
}

const userSocialSelectColumns = `id, username, email, stable_user_id, personal_org_id,
	display_name, bio, avatar_key, profile_visibility, created_at`

function mapUserSocialRow(row: Record<string, unknown>): UserSocialRow {
	return {
		id: Number(row['id']),
		username: String(row['username']),
		email: String(row['email']),
		stable_user_id: String(row['stable_user_id']),
		personal_org_id:
			row['personal_org_id'] == null ? null : String(row['personal_org_id']),
		display_name:
			row['display_name'] == null ? null : String(row['display_name']),
		bio: row['bio'] == null ? null : String(row['bio']),
		avatar_key: row['avatar_key'] == null ? null : String(row['avatar_key']),
		profile_visibility: String(row['profile_visibility']) as ProfileVisibility,
		created_at: String(row['created_at']),
	}
}

export function resolveCommunityDisplayName(input: {
	displayName: string | null
	username: string
}): string {
	const trimmed = input.displayName?.trim()
	if (trimmed) return trimmed
	return input.username
}

export async function getUserSocialRowByUsername(
	db: D1Database,
	username: string,
): Promise<UserSocialRow | null> {
	const row = await db
		.prepare(
			`SELECT ${userSocialSelectColumns}
			FROM users
			WHERE username = ?${andLiveDeletedAtSql()}`,
		)
		.bind(username)
		.first<Record<string, unknown>>()
	return row ? mapUserSocialRow(row) : null
}

export async function getUserSocialRowByStableId(
	db: D1Database,
	stableUserId: string,
): Promise<UserSocialRow | null> {
	const trimmed = stableUserId.trim()
	if (!trimmed) return null
	const row = await db
		.prepare(
			`SELECT ${userSocialSelectColumns}
			FROM users
			WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(trimmed)
		.first<Record<string, unknown>>()
	return row ? mapUserSocialRow(row) : null
}

export async function updateUserProfileFields(
	db: D1Database,
	input: {
		numericUserId: number
		displayName?: string | null
		bio?: string | null
		visibility?: ProfileVisibility
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []

	if (input.displayName !== undefined) {
		assignments.push('display_name = ?')
		values.push(input.displayName)
	}
	if (input.bio !== undefined) {
		assignments.push('bio = ?')
		values.push(input.bio)
	}
	if (input.visibility !== undefined) {
		assignments.push('profile_visibility = ?')
		values.push(input.visibility)
	}
	if (assignments.length === 0) return false

	assignments.push('updated_at = ?')
	values.push(utcSqliteTimestamp())

	const result = await db
		.prepare(
			`UPDATE users
			SET ${assignments.join(', ')}
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(...values, input.numericUserId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertCommunityActivityEvent(
	db: D1Database,
	input: {
		id: string
		actorUserId: string
		eventType: 'listing_published' | 'listing_updated'
		listingId: string
		createdAt?: string
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO community_activity_events (
				id, actor_user_id, event_type, listing_id, created_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.actorUserId,
			input.eventType,
			input.listingId,
			input.createdAt ?? new Date().toISOString(),
		)
		.run()
}

export async function deleteCommunityActivityEventsByListingId(
	db: D1Database,
	listingId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_activity_events WHERE listing_id = ?`)
		.bind(listingId)
		.run()
}

export async function deleteCommunityActivityEventsByActor(
	db: D1Database,
	actorUserId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_activity_events WHERE actor_user_id = ?`)
		.bind(actorUserId)
		.run()
}

function mapActivityRow(
	row: Record<string, unknown>,
	type: CommunityActivityEventType,
): CommunityActivityItem {
	const username = String(row['username'])
	const displayName =
		row['display_name'] == null ? null : String(row['display_name'])
	return {
		type,
		actorUserId: String(row['actor_user_id']),
		actorUsername: username,
		actorDisplayName: resolveCommunityDisplayName({
			displayName,
			username,
		}),
		actorAvatarKey:
			row['avatar_key'] == null ? null : String(row['avatar_key']),
		listingId: String(row['listing_id']),
		listingName: String(row['listing_name']),
		listingKodyId: String(row['listing_kody_id']),
		createdAt: String(row['created_at']),
	}
}

function compareActivityItems(
	left: CommunityActivityItem,
	right: CommunityActivityItem,
): number {
	const byCreatedAt = right.createdAt.localeCompare(left.createdAt)
	if (byCreatedAt !== 0) return byCreatedAt
	const byType = left.type.localeCompare(right.type)
	if (byType !== 0) return byType
	const byListing = left.listingId.localeCompare(right.listingId)
	if (byListing !== 0) return byListing
	return left.actorUserId.localeCompare(right.actorUserId)
}

export async function listCommunityActivityForActors(
	db: D1Database,
	input: {
		actorUserIds: Array<string>
		limit: number
		requirePublicActorProfile: boolean
	},
): Promise<Array<CommunityActivityItem>> {
	if (input.actorUserIds.length === 0 || input.limit <= 0) return []

	const publicProfileClause = input.requirePublicActorProfile
		? `AND u.profile_visibility = 'public'`
		: ''
	const idChunks = chunkArray(input.actorUserIds, maxSqlBindingsPerChunk)
	const chunkResults = await Promise.all(
		idChunks.map(async (idChunk) => {
			const placeholders = idChunk.map(() => '?').join(', ')
			const items: Array<CommunityActivityItem> = []

			const [storedRows, forkRows] = await Promise.all([
				db
					.prepare(
						`SELECT e.event_type AS event_type, e.actor_user_id AS actor_user_id,
							e.created_at AS created_at, l.id AS listing_id, l.name AS listing_name,
							l.kody_id AS listing_kody_id, u.username, u.display_name,
							u.avatar_key
						FROM community_activity_events e
						JOIN community_listings l ON l.id = e.listing_id AND l.status = 'active'${andLiveDeletedAtSql('l')}
						JOIN users u ON u.stable_user_id = e.actor_user_id ${publicProfileClause}${andLiveDeletedAtSql('u')}
						WHERE e.actor_user_id IN (${placeholders})
						ORDER BY e.created_at DESC
						LIMIT ?`,
					)
					.bind(...idChunk, input.limit)
					.all<Record<string, unknown>>(),
				db
					.prepare(
						`SELECT 'listing_forked' AS event_type, f.forker_user_id AS actor_user_id,
							f.created_at AS created_at, l.id AS listing_id, l.name AS listing_name,
							l.kody_id AS listing_kody_id, u.username, u.display_name,
							u.avatar_key
						FROM community_forks f
						JOIN community_listings l ON l.id = f.listing_id AND l.status = 'active'${andLiveDeletedAtSql('l')}
						JOIN saved_packages sp ON sp.id = f.forked_package_id
							AND sp.user_id = f.forker_user_id
							AND sp.is_private = 0${andLiveDeletedAtSql('sp')}
						JOIN users u ON u.stable_user_id = f.forker_user_id ${publicProfileClause}${andLiveDeletedAtSql('u')}
						WHERE f.forker_user_id IN (${placeholders})
						ORDER BY f.created_at DESC
						LIMIT ?`,
					)
					.bind(...idChunk, input.limit)
					.all<Record<string, unknown>>(),
			])

			for (const row of storedRows.results ?? []) {
				const eventType = String(row['event_type'])
				if (
					eventType !== 'listing_published' &&
					eventType !== 'listing_updated'
				) {
					continue
				}
				items.push(mapActivityRow(row, eventType))
			}
			for (const row of forkRows.results ?? []) {
				items.push(mapActivityRow(row, 'listing_forked'))
			}
			return items
		}),
	)

	const items = chunkResults.flat()
	items.sort(compareActivityItems)
	return items.slice(0, input.limit)
}

export async function countPublicSavedPackagesForUser(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM saved_packages
			WHERE user_id = ? AND is_private = 0 AND hidden = 0${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function countActiveListingsForOwner(
	db: D1Database,
	ownerUserId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM community_listings
			WHERE owner_user_id = ? AND status = 'active'${andLiveDeletedAtSql()}`,
		)
		.bind(ownerUserId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

const publicPackageSearchColumns = [
	'name',
	'kody_id',
	'description',
	'tags_json',
] as const

export async function listPublicProfilePackages(
	db: D1Database,
	input: {
		ownerStableUserId: string
		query?: string
		limit?: number
		/** When true, include private and hidden packages (own-profile inventory). */
		includePrivate?: boolean
	},
): Promise<Array<PublicProfilePackageListRow>> {
	const conditions = input.includePrivate
		? ['saved_packages.user_id = ?', 'saved_packages.deleted_at IS NULL']
		: [
				'saved_packages.user_id = ?',
				'saved_packages.is_private = 0',
				'saved_packages.hidden = 0',
				'saved_packages.deleted_at IS NULL',
			]
	const bindings: Array<unknown> = [input.ownerStableUserId]
	const tokens = extractCommunityListingLikeTokens(input.query ?? '')
	if (tokens.length > 0) {
		const tokenClauses = tokens.map((token) => {
			const pattern = d1ContainsLikePattern(token, { escape: false })
			const columnClauses = publicPackageSearchColumns.map((column) => {
				bindings.push(pattern)
				return `saved_packages.${column} LIKE ?`
			})
			return `(${columnClauses.join(' OR ')})`
		})
		conditions.push(`(${tokenClauses.join(' AND ')})`)
	}

	const limitClause = input.limit == null ? '' : '\n\t\t\tLIMIT ?'
	const statement = db.prepare(
		`SELECT saved_packages.id, saved_packages.name, saved_packages.kody_id,
				saved_packages.description, saved_packages.tags_json,
				saved_packages.created_at, saved_packages.updated_at,
				saved_packages.source_id, saved_packages.is_private,
				saved_packages.hidden, saved_packages.has_app,
				es.published_commit
			FROM saved_packages
			LEFT JOIN entity_sources AS es
				ON es.id = saved_packages.source_id
				AND es.user_id = saved_packages.user_id
				AND es.entity_kind = 'package'
				AND es.entity_id = saved_packages.id
			WHERE ${conditions.join(' AND ')}
				AND (es.id IS NULL OR es.deleted_at IS NULL)
			ORDER BY saved_packages.updated_at DESC${limitClause}`,
	)
	const bound =
		input.limit == null
			? statement.bind(...bindings)
			: statement.bind(...bindings, input.limit)
	const rows = await bound.all<Record<string, unknown>>()

	const packages = (rows.results ?? []).map((row) => ({
		packageId: String(row['id']),
		name: String(row['name']),
		kodyId: String(row['kody_id']),
		description: String(row['description']),
		tags: parseTagsJson(row['tags_json']),
		updatedAt: String(row['updated_at']),
		createdAt: String(row['created_at']),
		sourceId: String(row['source_id']),
		communityListingId: null as string | null,
		communityListingKodyId: null as string | null,
		communityPublishedAt: null as string | null,
		needsRepublish: false,
		hasPackage: true,
		hasApp: Number(row['has_app']) === 1,
		webhookCount: 0,
		jobCount: 0,
		isPrivate: Number(row['is_private']) === 1,
		hidden: Number(row['hidden']) === 1,
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		listingIconCommit: null as string | null,
		repoIconCommit: null as string | null,
	}))

	if (packages.length === 0) return packages

	const packageIds = packages.map((pkg) => pkg.packageId)
	// The listing's own `kody_id` travels with its id: it only moves on republish,
	// so it is the id the public URL actually resolves under.
	const listingByPackageId = new Map<
		string,
		{
			id: string
			kodyId: string | null
			publishedAt: string
			pinnedCommit: string
			sourcePublishedCommit: string | null
		}
	>()
	for (const idChunk of chunkArray(packageIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const listingRows = await db
			.prepare(
				`SELECT cl.id, cl.package_id, cl.kody_id, cl.published_at, cl.pinned_commit,
					es.published_commit AS source_published_commit
				FROM community_listings AS cl
				JOIN saved_packages AS sp
					ON sp.id = cl.package_id
					AND sp.user_id = cl.owner_user_id
				LEFT JOIN entity_sources AS es
					ON es.id = sp.source_id
					AND es.user_id = sp.user_id
					AND es.entity_kind = 'package'
					AND es.entity_id = sp.id
				WHERE cl.owner_user_id = ?
					AND cl.status = 'active'
					AND cl.package_id IN (${placeholders})${andLiveDeletedAtSql('cl')}${andLiveDeletedAtSql('sp')}${andLiveDeletedAtSql('es')}`,
			)
			.bind(input.ownerStableUserId, ...idChunk)
			.all<{
				id: string
				package_id: string
				kody_id: string | null
				published_at: string
				pinned_commit: string
				source_published_commit: string | null
			}>()
		for (const listingRow of listingRows.results ?? []) {
			listingByPackageId.set(listingRow.package_id, {
				id: listingRow.id,
				kodyId: listingRow.kody_id,
				publishedAt: String(listingRow.published_at),
				pinnedCommit: String(listingRow.pinned_commit),
				sourcePublishedCommit:
					listingRow.source_published_commit == null
						? null
						: String(listingRow.source_published_commit),
			})
		}
	}

	return packages.map((pkg) => {
		const listing = listingByPackageId.get(pkg.packageId)
		return {
			...pkg,
			communityListingId: listing?.id ?? null,
			communityListingKodyId: listing?.kodyId ?? null,
			communityPublishedAt: listing?.publishedAt ?? null,
			needsRepublish: listingNeedsRepublish({
				listingPinnedCommit: listing?.pinnedCommit,
				sourcePublishedCommit: listing?.sourcePublishedCommit,
			}),
			listingIconCommit:
				listing?.sourcePublishedCommit ?? listing?.pinnedCommit ?? null,
		}
	})
}

const publicRepoSearchColumns = ['name', 'description'] as const

/**
 * Plain repos (`user_repos`) for the repositories list. Same owner key and
 * private filter as {@link listPublicProfilePackages}; no community listing.
 */
export async function listPublicProfileRepos(
	db: D1Database,
	input: {
		ownerStableUserId: string
		ownerUsername: string
		query?: string
		limit?: number
		/** When true, include private repos (own-profile / org inventory). */
		includePrivate?: boolean
	},
): Promise<Array<PublicProfilePackageListRow>> {
	const conditions = input.includePrivate
		? ['user_repos.user_id = ?', 'user_repos.deleted_at IS NULL']
		: [
				'user_repos.user_id = ?',
				'user_repos.is_private = 0',
				'user_repos.deleted_at IS NULL',
			]
	const bindings: Array<unknown> = [input.ownerStableUserId]
	const ownerUsername = input.ownerUsername.trim().replace(/^@/, '')
	const tokens = extractCommunityListingLikeTokens(input.query ?? '')
	if (tokens.length > 0) {
		const tokenClauses = tokens.map((token) => {
			const pattern = d1ContainsLikePattern(token, { escape: false })
			const columnClauses = publicRepoSearchColumns.map((column) => {
				bindings.push(pattern)
				return `user_repos.${column} LIKE ?`
			})
			// Match `@owner/leaf` the same way package search matches `name`.
			bindings.push(ownerUsername)
			bindings.push(pattern)
			columnClauses.push(`('@' || ? || '/' || user_repos.name) LIKE ?`)
			return `(${columnClauses.join(' OR ')})`
		})
		conditions.push(`(${tokenClauses.join(' AND ')})`)
	}

	const limitClause = input.limit == null ? '' : '\n\t\t\tLIMIT ?'
	const statement = db.prepare(
		`SELECT user_repos.id, user_repos.name, user_repos.description,
				user_repos.is_private, user_repos.created_at, user_repos.updated_at,
				entity_sources.id AS source_id,
				entity_sources.indexed_commit AS indexed_commit,
				entity_sources.published_commit AS published_commit
			FROM user_repos
			LEFT JOIN entity_sources
				ON entity_sources.user_id = user_repos.user_id
				AND entity_sources.entity_kind = 'repo'
				AND entity_sources.entity_id = user_repos.id
				AND entity_sources.deleted_at IS NULL
			WHERE ${conditions.join(' AND ')}
			ORDER BY user_repos.updated_at DESC${limitClause}`,
	)
	const bound =
		input.limit == null
			? statement.bind(...bindings)
			: statement.bind(...bindings, input.limit)
	const rows = await bound.all<Record<string, unknown>>()

	return (rows.results ?? []).map((row) => {
		const leaf = String(row['name'])
		const indexed =
			row['indexed_commit'] == null ? null : String(row['indexed_commit'])
		const published =
			row['published_commit'] == null ? null : String(row['published_commit'])
		return {
			packageId: String(row['id']),
			name: `@${ownerUsername}/${leaf}`,
			kodyId: leaf,
			description: row['description'] == null ? '' : String(row['description']),
			tags: [] as Array<string>,
			updatedAt: String(row['updated_at']),
			createdAt: String(row['created_at']),
			sourceId: row['source_id'] == null ? '' : String(row['source_id']),
			communityListingId: null,
			communityListingKodyId: null,
			communityPublishedAt: null,
			needsRepublish: false,
			hasPackage: false,
			hasApp: false,
			webhookCount: 0,
			jobCount: 0,
			isPrivate: Number(row['is_private']) === 1,
			hidden: false,
			publishedCommit: null,
			listingIconCommit: null,
			repoIconCommit: indexed ?? published,
		}
	})
}

export async function countWebhooksByPackageId(
	db: D1Database,
	input: {
		ownerStableUserId: string
		packageIds: Array<string>
	},
): Promise<Map<string, number>> {
	const counts = new Map<string, number>()
	if (input.packageIds.length === 0) return counts
	for (const idChunk of chunkArray(input.packageIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT package_id, COUNT(*) AS count
				FROM webhook_endpoints
				WHERE user_id = ? AND package_id IN (${placeholders})${andLiveDeletedAtSql()}
				GROUP BY package_id`,
			)
			.bind(input.ownerStableUserId, ...idChunk)
			.all<{ package_id: string; count: number }>()
		for (const row of rows.results ?? []) {
			counts.set(String(row.package_id), Number(row.count ?? 0))
		}
	}
	return counts
}
