import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { toPublicProfilePackageItem } from '#app/community-public.ts'
import {
	canSeeResource,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { listProfileRepositories } from '#worker/community/profile-service.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import { type OrgBinding } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { type ProfileLoaderData } from '#universal/loader-data.ts'

/**
 * Repositories owned by a team org (`saved_packages` and `user_repos` with
 * `user_id = org.id`), for `/@slug/-/repositories`. Packages pass `canSeeResource`
 * (owners see everything; members see grants). Plain repos have no grant
 * surface — every org member who can open this page sees them (same inventory
 * as MCP `repoList` for the bound org).
 */
export async function loadOrgRepositoriesData(input: {
	env: Env
	query: string
	limit?: number
	user: { mcpUser: McpUserContext }
	binding: OrgBinding
	includeAppGrants?: boolean
}): Promise<ProfileLoaderData> {
	const orgId = input.binding.org.id
	const slug = input.binding.org.slug ?? ''
	const query = input.query.trim()
	const limit = input.limit
	const [org, access, repositories] = await Promise.all([
		input.env.APP_DB.prepare(
			`SELECT display_name, avatar_key, created_at FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(orgId)
			.first<{
				display_name: string | null
				avatar_key: string | null
				created_at: string
			}>(),
		computeEffectivePermissions({
			env: input.env,
			request: deriveRequestContext({
				user: input.user.mcpUser,
				source: { kind: 'session' },
				orgBinding: input.binding,
			}),
		}),
		// Uncapped: the cap applies after the package visibility filter, or
		// packages the viewer cannot see could fill it and hide ones they can.
		listProfileRepositories({
			env: input.env,
			ownerStableUserId: orgId,
			ownerUsername: slug,
			...(limit != null && query ? { query } : {}),
			includePrivate: true,
		}),
	])
	const allVisible = repositories.filter((pkg) => {
		if (!pkg.hasPackage) return true
		return (
			canSeeResource(
				access,
				packageResource({ id: pkg.packageId, userId: orgId, label: pkg.name }),
			) ||
			(Boolean(input.includeAppGrants && pkg.hasApp) &&
				checkPermission(access, 'app:execute', {
					type: 'app',
					id: pkg.packageId,
					orgId,
				}).allowed)
		)
	})
	const visible = limit == null ? allVisible : allVisible.slice(0, limit)
	return {
		ok: true,
		profile: {
			username: slug,
			displayName: org?.display_name?.trim() || `@${slug}`,
			bio: null,
			avatarUrl: buildOrgAvatarUrl({
				slug,
				avatarKey: org?.avatar_key ?? null,
			}),
			visibility: 'public',
			joinedAt: org?.created_at ?? '',
			publicPackageCount: visible.filter((pkg) => !pkg.isPrivate).length,
			listingCount: visible.filter((pkg) => pkg.communityListingId).length,
		},
		packages: visible.map((pkg) => {
			if (!pkg.hasPackage) {
				return toPublicProfilePackageItem(pkg, {
					includeOwnerVisibility: true,
					username: slug,
				})
			}
			const resource = packageResource({
				id: pkg.packageId,
				userId: orgId,
				label: pkg.name,
			})
			// List visibility is broader than the owner package page
			// (read|execute|write). Link when the viewer can open that page
			// (`package:read`), or when a public community listing makes the
			// canonical `/@slug/kodyId` URL resolve without read.
			const canOpenDetail =
				checkPermission(access, 'package:read', resource).allowed ||
				Boolean(pkg.communityListingId)
			const item = toPublicProfilePackageItem(pkg, {
				includeOwnerVisibility: true,
				username: slug,
				canOpenDetail,
			})
			// Private and hidden package icons require package read access. App-only
			// viewers still get a monogram instead of an inaccessible image.
			return !canOpenDetail && (pkg.isPrivate || pkg.hidden)
				? { ...item, iconUrl: null }
				: item
		}),
		activity: null,
		query: query || null,
		isSelf: true,
		loggedIn: true,
	}
}
