import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import { viewerCanReadSavedPackage } from '#worker/app/package-viewer-access.ts'
import {
	checkOrgWide,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { resolvePackagePageUrl } from '#worker/community/package-url.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { kodyPackageIdPattern } from '#worker/package-registry/types.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import { getUserRepoByName } from '#worker/repo/user-repos.ts'
import {
	apiTokenScopeIncludes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'

export type GitHttpResourceKind = 'package' | 'repo'

export type ResolvedGitHttpTarget = {
	ownerHandle: string
	repoName: string
	resourceKind: GitHttpResourceKind
	resourceId: string
	resourceOrgId: string
	sourceId: string
	repoId: string
	canRead: boolean
	canWrite: boolean
}

/**
 * Parse git-credential `path` / URL pathname into `@owner/name` leaf.
 * Accepts `owner/name.git`, `/@owner/name.git`, and smart-HTTP suffixes.
 */
export function parseGitCredentialRepoPath(path: string): {
	ownerHandle: string
	repoName: string
} | null {
	const trimmed = path.trim()
	const withoutQuery = trimmed.split('?')[0] ?? trimmed
	const parts = withoutQuery.split('/').filter(Boolean)
	if (parts.length < 2) return null
	const ownerPart = parts[0] ?? ''
	const repoPart = parts[1] ?? ''
	const ownerHandle = ownerPart.startsWith('@') ? ownerPart.slice(1) : ownerPart
	let repoSegment: string
	try {
		repoSegment = decodeURIComponent(repoPart)
	} catch {
		return null
	}
	if (!ownerHandle || !repoSegment.toLowerCase().endsWith('.git')) return null
	const repoName = repoSegment.slice(0, -'.git'.length)
	if (!repoName || !kodyPackageIdPattern.test(repoName)) return null
	return { ownerHandle, repoName }
}

/**
 * Resolve `@owner/name` to a package (preferred) or plain repo the caller may
 * access. Prefers a package when both a package and a repo share the name
 * (today's collision) and the caller may access that package. Scopes have no
 * hierarchy: upload-pack needs `package:read`; receive-pack needs
 * `package:write` (write-only tokens may push without clone). Returns null
 * when the caller cannot access for `needWrite`.
 *
 * Git auth is **user-wide across orgs** (ADR 0070 / `guide:auth_setup_git`):
 * there is no `?org=` on the git URL and the login org must not gate access.
 * Authz binds to the **resource owner's** org via membership or a live grant
 * (`loadOrgBindingForOrg(viewer, resourceOwnerId)`), plus the token's scopes.
 * A user-owned `setup-git` token (`org_binding: user`) must therefore open
 * every `@owner/name.git` the person can already access in any org.
 */
export async function resolveGitHttpTargetAccess(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'>
	ownerHandle: string
	repoName: string
	scopes: ReadonlyArray<ApiTokenScope> | null
	needWrite: boolean
}): Promise<ResolvedGitHttpTarget | null> {
	const hasReadScope = apiTokenScopesAllow(input.scopes, 'package:read')
	const hasWriteScope = apiTokenScopesAllow(input.scopes, 'package:write')
	// Receive-pack needs write scope (write-only ok). Upload-pack needs read.
	// Read-without-write on push still resolves so the caller can return 403.
	if (input.needWrite) {
		if (!hasWriteScope && !hasReadScope) return null
	} else if (!hasReadScope) {
		return null
	}

	const identity = await findPublicOwnerIdentityByHandle({
		db: input.env.APP_DB,
		handle: input.ownerHandle,
	})
	if (!identity) return null

	const packagePage = await resolvePackagePageUrl({
		db: input.env.APP_DB,
		username: identity.handle,
		kodyId: input.repoName,
	})
	if (packagePage?.kind === 'package' && packagePage.savedPackage) {
		const access = await loadScopedPackageAccess({
			env: input.env,
			viewer: input.viewer,
			ownerId: packagePage.userId,
			scopes: input.scopes,
		})
		const resource = packageResource({
			id: packagePage.savedPackage.id,
			userId: packagePage.userId,
		})
		const canWrite =
			hasWriteScope &&
			!!access &&
			checkPermission(access, 'package:write', resource).allowed
		const canRead =
			hasReadScope &&
			!!access &&
			checkPermission(access, 'package:read', resource).allowed

		if (input.needWrite) {
			// Write access, or readable-without-write (caller returns 403).
			if (canWrite || canRead) {
				const source = await getEntitySourceByEntity(input.env.APP_DB, {
					userId: packagePage.userId,
					entityKind: 'package',
					entityId: packagePage.savedPackage.id,
				})
				if (!source?.repo_id) return null
				return {
					ownerHandle: identity.handle,
					repoName: packagePage.kodyId,
					resourceKind: 'package',
					resourceId: packagePage.savedPackage.id,
					resourceOrgId: packagePage.userId,
					sourceId: source.id,
					repoId: source.repo_id,
					canRead,
					canWrite,
				}
			}
		} else {
			const canView = await viewerCanReadSavedPackage({
				env: input.env,
				viewer: input.viewer,
				ownerId: packagePage.userId,
				packageId: packagePage.savedPackage.id,
			})
			if (canView && canRead) {
				const source = await getEntitySourceByEntity(input.env.APP_DB, {
					userId: packagePage.userId,
					entityKind: 'package',
					entityId: packagePage.savedPackage.id,
				})
				if (!source?.repo_id) return null
				return {
					ownerHandle: identity.handle,
					repoName: packagePage.kodyId,
					resourceKind: 'package',
					resourceId: packagePage.savedPackage.id,
					resourceOrgId: packagePage.userId,
					sourceId: source.id,
					repoId: source.repo_id,
					canRead: true,
					canWrite,
				}
			}
		}
	}

	const userRepo = await getUserRepoByName(input.env.APP_DB, {
		userId: identity.ownerId,
		name: input.repoName,
	})
	if (!userRepo) return null
	const access = await loadScopedPackageAccess({
		env: input.env,
		viewer: input.viewer,
		ownerId: identity.ownerId,
		scopes: input.scopes,
	})
	// Plain repos require org-wide package:read/write (same as repoGetGitRemote).
	// A single-package grant must not open every plain repo under the owner.
	if (!access) return null
	const canWrite =
		hasWriteScope && checkOrgWide(access, 'package:write').allowed
	const canRead = hasReadScope && checkOrgWide(access, 'package:read').allowed
	if (input.needWrite) {
		// Write access, or readable-without-write (caller returns 403).
		if (!canWrite && !canRead) return null
	} else if (!canRead) {
		return null
	}
	const source = await getEntitySourceByEntity(input.env.APP_DB, {
		userId: identity.ownerId,
		entityKind: 'repo',
		entityId: userRepo.id,
	})
	if (!source?.repo_id) return null
	return {
		ownerHandle: identity.handle,
		repoName: userRepo.name,
		resourceKind: 'repo',
		resourceId: userRepo.id,
		resourceOrgId: identity.ownerId,
		sourceId: source.id,
		repoId: source.repo_id,
		canRead,
		canWrite,
	}
}

function apiTokenScopesAllow(
	scopes: ReadonlyArray<ApiTokenScope> | null,
	required: ApiTokenScope,
) {
	if (scopes === null) return true
	return apiTokenScopeIncludes(scopes, required)
}

async function loadScopedPackageAccess(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'>
	/** Resource owner org id (`@owner` of the git URL), never the login org. */
	ownerId: string
	scopes: ReadonlyArray<ApiTokenScope> | null
}): Promise<EffectivePermissions | null> {
	// Bind to the resource owner's org — not token.org_id / MCP login org.
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return null
	return computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'api-token', tokenId: 'git-http' },
			orgBinding: binding,
			scopes: input.scopes,
		}),
	})
}
