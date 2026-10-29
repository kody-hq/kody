import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'
import { isPersonalOrg } from './is-personal-org.ts'

export const orgProfileVisibilities = ['public', 'private'] as const

export type OrgProfileVisibility = (typeof orgProfileVisibilities)[number]

export type TeamOrgProfileRow = {
	id: string
	slug: string
	display_name: string | null
	bio: string | null
	avatar_key: string | null
	profile_visibility: OrgProfileVisibility
	created_at: string
}

/** Anything but an explicit `private` is public (same rule as the org avatar route). */
export function orgProfileIsPublic(visibility: string | null | undefined) {
	return visibility !== 'private'
}

/** Stored visibility of a live org row; a missing row reads as public. */
export async function loadOrgProfileVisibility(
	db: D1Database,
	orgId: string,
): Promise<OrgProfileVisibility> {
	const row = await db
		.prepare(
			`SELECT profile_visibility FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ profile_visibility: string | null }>()
	return orgProfileIsPublic(row?.profile_visibility) ? 'public' : 'private'
}

/**
 * A live, unsuspended team org by handle. Signup (personal) orgs return null:
 * their public face is the person's profile and `users.profile_visibility`.
 */
export async function loadTeamOrgProfileBySlug(
	db: D1Database,
	slug: string,
): Promise<TeamOrgProfileRow | null> {
	const normalized = slug.trim().toLowerCase()
	if (!normalized) return null
	const row = await db
		.prepare(
			`SELECT o.id, o.slug, o.display_name, o.bio, o.avatar_key,
				o.profile_visibility, o.created_at
			 FROM orgs o
			 WHERE o.slug = ?${andActiveOrgSql('o')}`,
		)
		.bind(normalized)
		.first<{
			id: string
			slug: string
			display_name: string | null
			bio: string | null
			avatar_key: string | null
			profile_visibility: string | null
			created_at: string
		}>()
	if (!row) return null
	if (await isPersonalOrg(db, row.id)) return null
	return {
		...row,
		profile_visibility: orgProfileIsPublic(row.profile_visibility)
			? 'public'
			: 'private',
	}
}

/**
 * Whether `/@handle` is a public page, for owner links on package pages. A
 * person follows `users.profile_visibility`; a team org (no `users` row)
 * follows `orgs.profile_visibility`.
 */
export async function loadOwnerProfilePublic(
	db: D1Database,
	handle: string,
): Promise<boolean> {
	const person = await getUserSocialRowByUsername(db, handle)
	if (person) return person.profile_visibility === 'public'
	const org = await loadTeamOrgProfileBySlug(db, handle)
	return org?.profile_visibility === 'public'
}
