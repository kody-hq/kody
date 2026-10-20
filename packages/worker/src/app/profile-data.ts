import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	readAuthenticatedAppUser,
	type ReadAuthenticatedAppUserOptions,
} from '#app/authenticated-user.ts'
import {
	toPublicCommunityActivityItem,
	toPublicCommunityProfile,
	toPublicProfilePackageItem,
} from '#app/community-public.ts'
import { type ProfileLoaderData } from '#universal/loader-data.ts'
import {
	canSeeResource,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import {
	getCommunityProfileByUsername,
	getProfileActivity,
	listProfileRepositories,
} from '#worker/community/profile-service.ts'
import { type PublicProfilePackage } from '#worker/community/types.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { loadOrgBindingForOrg, type OrgBinding } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

const defaultProfileActivityLimit = 20
const requestProfileDataStore = new WeakMap<
	Request,
	Map<string, Promise<ProfileLoaderData | null>>
>()

export function loadProfileData(
	env: Env,
	request: Request,
	username: string,
	options: ReadAuthenticatedAppUserOptions | undefined,
	resource: { query: string; limit?: number },
): Promise<ProfileLoaderData | null> {
	let byUsername = requestProfileDataStore.get(request)
	if (!byUsername) {
		byUsername = new Map()
		requestProfileDataStore.set(request, byUsername)
	}
	const cacheKey = `${username}:${JSON.stringify(resource)}`
	let pending = byUsername.get(cacheKey)
	if (!pending) {
		pending = loadProfileDataUncached(env, request, username, options, resource)
		byUsername.set(cacheKey, pending)
	}
	return pending
}

/**
 * Packages and plain repos are keyed by the profile's personal org id
 * (`handles.org_id` / `users.personal_org_id`), not the person id. Listing by
 * person id returns an empty inventory for post-#3053 signups.
 */
async function resolveProfileOwnerOrgId(input: {
	env: Env
	username: string
	personId: string
}) {
	const identity = await findPublicOwnerIdentityByHandle({
		db: input.env.APP_DB,
		handle: input.username,
	})
	if (identity) return identity.ownerId
	return await loadPersonalOrgIdForPerson(
		input.env.APP_DB,
		personIdFromStored(input.personId),
	)
}

function isPublicProfileRepository(pkg: PublicProfilePackage) {
	return !pkg.isPrivate && !pkg.hidden
}

/**
 * Same `canSeeResource` gate as {@link loadOrgRepositoriesData}. Public
 * (non-hidden) packages stay visible on a public profile without a grant.
 * Plain repos have no grant surface: members/owners see private ones; grant-only
 * collaborators and guests do not.
 */
function filterProfileRepositoriesForViewer(input: {
	repositories: Array<PublicProfilePackage>
	ownerOrgId: string
	binding: OrgBinding
	access: EffectivePermissions
}) {
	return input.repositories.filter((pkg) => {
		if (!pkg.hasPackage) {
			// Plain repos have no grant surface. Owners and members see private
			// ones; billing and grant-only collaborators do not.
			return (
				!pkg.isPrivate ||
				input.binding.role === 'owner' ||
				input.binding.role === 'member'
			)
		}
		if (isPublicProfileRepository(pkg)) return true
		return canSeeResource(
			input.access,
			packageResource({
				id: pkg.packageId,
				userId: input.ownerOrgId,
				label: pkg.name,
			}),
		)
	})
}

async function loadProfileDataUncached(
	env: Env,
	request: Request,
	username: string,
	options: ReadAuthenticatedAppUserOptions | undefined,
	resource: { query: string; limit?: number },
): Promise<ProfileLoaderData | null> {
	if (getUsernameFormatValidationError(username)) {
		return null
	}

	const user = await readAuthenticatedAppUser(request, env, options)
	const profile = await getCommunityProfileByUsername({
		env,
		username,
		includePrivate: true,
	})
	if (!profile) return null

	const viewerStableId = user?.mcpUser.userId ?? null
	const isSelf = viewerStableId != null && profile.userId === viewerStableId
	if (profile.visibility === 'private' && !isSelf) {
		return null
	}

	const ownerOrgId = await resolveProfileOwnerOrgId({
		env,
		username: profile.username,
		personId: profile.userId,
	})
	const binding = user
		? await loadOrgBindingForOrg(env.APP_DB, user.mcpUser.userId, ownerOrgId)
		: null

	const packageLimit = resource.limit
	const serverQuery =
		packageLimit == null ? undefined : resource.query || undefined
	// Owners, members, and grant holders: list private inventory then filter
	// with canSeeResource (uncapped so the limit cannot hide visible rows).
	// Everyone else: SQL public-only so private names never leave the server.
	const includePrivate = binding != null

	const [repositories, activity, access] = await Promise.all([
		listProfileRepositories({
			env,
			ownerStableUserId: ownerOrgId,
			ownerUsername: profile.username,
			...(serverQuery ? { query: serverQuery } : {}),
			...(includePrivate || packageLimit == null
				? {}
				: { limit: packageLimit }),
			includePrivate,
		}),
		getProfileActivity({
			env,
			actorUserId: profile.userId,
			limit: defaultProfileActivityLimit,
			isSelf,
		}),
		binding && user
			? computeEffectivePermissions({
					env,
					request: deriveRequestContext({
						user: user.mcpUser,
						source: { kind: 'session' },
						orgBinding: binding,
					}),
				})
			: Promise.resolve(null),
	])

	const allVisible =
		binding && access
			? filterProfileRepositoriesForViewer({
					repositories,
					ownerOrgId,
					binding,
					access,
				})
			: repositories
	const visible =
		packageLimit == null || !includePrivate
			? allVisible
			: allVisible.slice(0, packageLimit)

	// Private / hidden badges for anyone who already passed the access filter.
	const includeOwnerVisibility = binding != null

	return {
		ok: true,
		profile: toPublicCommunityProfile(profile),
		packages: visible.map((pkg) => {
			if (!pkg.hasPackage || !access || !binding) {
				return toPublicProfilePackageItem(pkg, {
					includeOwnerVisibility,
					username: profile.username,
				})
			}
			const resourceRef = packageResource({
				id: pkg.packageId,
				userId: ownerOrgId,
				label: pkg.name,
			})
			// Public profile rows stay linked for grant holders the same way
			// anonymous viewers get a link: the canonical /@owner/kodyId URL
			// resolves without package:read. Private rows still need read (or a
			// public listing) before the name is clickable.
			const canOpenDetail =
				isPublicProfileRepository(pkg) ||
				checkPermission(access, 'package:read', resourceRef).allowed ||
				Boolean(pkg.communityListingId)
			return toPublicProfilePackageItem(pkg, {
				includeOwnerVisibility,
				username: profile.username,
				canOpenDetail,
			})
		}),
		activity: activity.map(toPublicCommunityActivityItem),
		query: resource.query || null,
		isSelf,
		loggedIn: Boolean(user),
	}
}
