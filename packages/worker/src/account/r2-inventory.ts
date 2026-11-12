import { fileStoreRpc } from '#worker/files/client.ts'
/**
 * soft-delete-read-filter: opt-out
 *
 * Account deletion / purge inventory must enumerate tombstoned rows so KV, R2,
 * and DO cleanup still run after soft-delete.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { accountUserOwnedR2Surfaces } from '#worker/account/user-owned-surfaces.ts'
import { buildCommunityIconR2Key } from '#worker/community/community-icon.ts'
import {
	buildIdentityIconR2Key,
	identityIconCommitForKind,
} from '#worker/repo/identity-icon.ts'
import type { EntityKind } from '#worker/repo/types.ts'
import { listAllMailboxEmailObjectRefs } from './mailbox-r2-references.ts'

/** R2 bindings `collectAccountR2Inventory` can name. */
export type AccountR2Binding = 'EMAIL_BLOBS' | 'COMMUNITY_ASSETS' | 'FILE_BLOBS'

export type AccountR2ObjectRef = {
	surfaceId: (typeof accountUserOwnedR2Surfaces)[number]['id']
	binding: AccountR2Binding
	key: string
}

export type AccountCommunityListingSnapshot = {
	id: string
	pinnedCommit: string
	iconCommit: string
}

export type AccountIdentityIconSnapshot = {
	repoId: string
	iconCommit: string
}

function uniqueObjects(objects: ReadonlyArray<AccountR2ObjectRef>) {
	const seen = new Set<string>()
	const unique: Array<AccountR2ObjectRef> = []
	for (const object of objects) {
		const identity = `${object.binding}:${object.key}`
		if (!object.key.trim() || seen.has(identity)) continue
		seen.add(identity)
		unique.push(object)
	}
	return unique
}

function bindingFor(
	surfaceId: AccountR2ObjectRef['surfaceId'],
): AccountR2Binding {
	const surface = accountUserOwnedR2Surfaces.find(
		(candidate) => candidate.id === surfaceId,
	)
	if (!surface || surface.export !== 'chunked_bytes') {
		throw new Error(`Missing chunked R2 export disposition for ${surfaceId}.`)
	}
	return surface.binding
}

async function listUserCommunityListings(env: Env, userId: OwnerId) {
	const listings: Array<AccountCommunityListingSnapshot> = []
	let afterRowid = 0
	const pageSize = 500
	while (true) {
		const rows = await env.APP_DB.prepare(
			`SELECT community_listings.rowid AS account_r2_rowid,
				community_listings.id, community_listings.pinned_commit,
				entity_sources.published_commit AS source_published_commit
			FROM community_listings
			LEFT JOIN entity_sources
				ON entity_sources.id = community_listings.source_id
				AND entity_sources.user_id = community_listings.owner_user_id
				AND entity_sources.entity_kind = 'package'
				AND entity_sources.entity_id = community_listings.package_id
			WHERE community_listings.owner_user_id = ?
				AND community_listings.rowid > ?
			ORDER BY community_listings.rowid LIMIT ?`,
		)
			.bind(userId, afterRowid, pageSize + 1)
			.all<{
				account_r2_rowid: number
				id: string
				pinned_commit: string
				source_published_commit: string | null
			}>()
		const page = rows.results ?? []
		const truncated = page.length > pageSize
		const included = truncated ? page.slice(0, pageSize) : page
		listings.push(
			...included.map((row) => ({
				id: row.id,
				pinnedCommit: row.pinned_commit,
				iconCommit: row.source_published_commit ?? row.pinned_commit,
			})),
		)
		if (!truncated) return listings
		afterRowid = included.at(-1)?.account_r2_rowid ?? afterRowid
	}
}

async function listUserIdentityIcons(env: Env, userId: OwnerId) {
	const icons: Array<AccountIdentityIconSnapshot> = []
	let afterRowid = 0
	const pageSize = 500
	while (true) {
		const rows = await env.APP_DB.prepare(
			`SELECT entity_sources.rowid AS account_r2_rowid,
				entity_sources.repo_id,
				entity_sources.entity_kind,
				entity_sources.published_commit,
				entity_sources.indexed_commit
			FROM entity_sources
			WHERE entity_sources.user_id = ?
				AND entity_sources.rowid > ?
			ORDER BY entity_sources.rowid LIMIT ?`,
		)
			.bind(userId, afterRowid, pageSize + 1)
			.all<{
				account_r2_rowid: number
				repo_id: string
				entity_kind: EntityKind
				published_commit: string | null
				indexed_commit: string | null
			}>()
		const page = rows.results ?? []
		const truncated = page.length > pageSize
		const included = truncated ? page.slice(0, pageSize) : page
		for (const row of included) {
			const iconCommit = identityIconCommitForKind({
				entityKind: row.entity_kind,
				publishedCommit: row.published_commit,
				indexedCommit: row.indexed_commit,
			})
			if (iconCommit) {
				icons.push({ repoId: row.repo_id, iconCommit })
			}
		}
		if (!truncated) return icons
		afterRowid = included.at(-1)?.account_r2_rowid ?? afterRowid
	}
}

/**
 * User-owned R2 objects for account deletion and export: FileStore revision
 * keys in `FILE_BLOBS` when `FILE_STORE` is bound, mailbox MIME and attachments
 * in `EMAIL_BLOBS`, and community/identity icons plus the profile avatar in
 * `COMMUNITY_ASSETS`. File keys come from `FileStore.inventory`, not D1.
 */
export async function collectAccountR2Inventory(input: {
	env: Env
	userId: OwnerId
	dbUserId: number
}): Promise<{
	objects: Array<AccountR2ObjectRef>
	communityListings: Array<AccountCommunityListingSnapshot>
}> {
	const [emailBlobReferences, communityListings, identityIcons, avatarRow] =
		await Promise.all([
			listAllMailboxEmailObjectRefs({
				env: input.env,
				ownerId: input.userId,
			}),
			listUserCommunityListings(input.env, input.userId),
			listUserIdentityIcons(input.env, input.userId),
			input.env.APP_DB.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.first<{ avatar_key: string | null }>(),
		])

	const fileObjects = input.env.FILE_STORE
		? await fileStoreRpc(input.env, input.userId).inventory(input.userId)
		: []
	const objects: Array<AccountR2ObjectRef> = [
		...fileObjects.map((key) => ({
			surfaceId: 'file_revision' as const,
			binding: 'FILE_BLOBS' as const,
			key,
		})),
		...emailBlobReferences,
		...communityListings.flatMap((listing) =>
			[listing.pinnedCommit, listing.iconCommit].map((commit) => ({
				surfaceId: 'community_icon' as const,
				binding: bindingFor('community_icon'),
				key: buildCommunityIconR2Key({
					listingId: listing.id,
					commit,
				}),
			})),
		),
		...identityIcons.map((icon) => ({
			surfaceId: 'identity_icon' as const,
			binding: bindingFor('identity_icon'),
			key: buildIdentityIconR2Key({
				repoId: icon.repoId,
				commit: icon.iconCommit,
			}),
		})),
		...(avatarRow?.avatar_key
			? [
					{
						surfaceId: 'user_avatar' as const,
						binding: bindingFor('user_avatar'),
						key: avatarRow.avatar_key,
					},
				]
			: []),
	]
	return { objects: uniqueObjects(objects), communityListings }
}
