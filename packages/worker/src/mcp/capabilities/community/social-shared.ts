import { z } from 'zod'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import type {
	CommunityProfileRecord,
	PublicProfilePackage,
} from '#worker/community/types.ts'
import { communityActivityItemSchema } from './shared.ts'

export const communityProfileVisibilitySchema = z.enum(['public', 'private'])

export const communityProfileOutputSchema = z.object({
	username: z.string(),
	display_name: z.string(),
	bio: z.string().nullable(),
	avatar_url: z.string().nullable(),
	visibility: communityProfileVisibilitySchema,
	joined_at: z.string(),
	public_package_count: z.number().int().nonnegative(),
	listing_count: z.number().int().nonnegative(),
})

export const communityProfilePackageSchema = z.object({
	package_id: z.string().optional(),
	name: z.string(),
	kody_id: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	updated_at: z
		.string()
		.describe(
			'Last time the owner edited the saved package. Independent of what is published to the community.',
		),
	community_listing_id: z.string().nullable(),
	community_published_at: z
		.string()
		.nullable()
		.describe(
			'Last time the package was published to its catalog entry, or null when it has no active listing.',
		),
	needs_republish: z
		.boolean()
		.describe(
			'True when the active catalog entry pin is behind the package published commit. False when there is no listing, or the pin matches. Do not derive this from updated_at versus published_at.',
		),
	hidden: z
		.boolean()
		.optional()
		.describe(
			'Present only on the caller’s own profile. Hidden packages stay off ranked search.',
		),
	is_private: z
		.boolean()
		.optional()
		.describe(
			'Present only on the caller’s own profile. Repo visibility (`saved_packages.is_private`), not package.json#private.',
		),
})

export const communityProfileGetOutputSchema = z.object({
	user_found: z.boolean(),
	profile: communityProfileOutputSchema.nullable(),
	packages: z.array(communityProfilePackageSchema),
	recent_activity: z.array(communityActivityItemSchema),
})

export function toCommunityProfileOutput(
	profile: CommunityProfileRecord,
	baseUrl: string,
) {
	const avatarPath = buildUserAvatarUrl({
		username: profile.username,
		avatarKey: profile.avatarKey,
	})
	return {
		username: profile.username,
		display_name: profile.displayName,
		bio: profile.bio,
		avatar_url: avatarPath ? `${baseUrl}${avatarPath}` : null,
		visibility: profile.visibility,
		joined_at: profile.joinedAt,
		public_package_count: profile.publicPackageCount,
		listing_count: profile.listingCount,
	}
}

export function toCommunityProfilePackageOutput(
	pkg: PublicProfilePackage,
	options: { includePackageId: boolean },
) {
	const output: {
		package_id?: string
		name: string
		kody_id: string
		description: string
		tags: Array<string>
		updated_at: string
		community_listing_id: string | null
		community_published_at: string | null
		needs_republish: boolean
		hidden?: boolean
		is_private?: boolean
	} = {
		name: pkg.name,
		kody_id: pkg.kodyId,
		description: pkg.description,
		tags: pkg.tags,
		updated_at: pkg.updatedAt,
		community_listing_id: pkg.communityListingId,
		community_published_at: pkg.communityPublishedAt,
		needs_republish: pkg.needsRepublish,
	}
	if (options.includePackageId) {
		output.package_id = pkg.packageId
		output.hidden = pkg.hidden
		output.is_private = pkg.isPrivate
	}
	return output
}
