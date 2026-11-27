import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	type EffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { checkAppVisitAccess } from '#worker/app-visit/authorize.ts'
import { loadOrgBindingForOrg, type OrgBinding } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import type { PackageAppSessionCredential } from '#app/package-app-session.ts'

/**
 * Whether a signed-in person may open the owner view of a saved package on
 * `/@owner/<kody-id>` (details, source files, private icon). The person must
 * belong to (or hold a grant in) the org that owns the package and hold
 * `package:read` on it there, the same check as `packageGet`. The signup org
 * owner reads every package it owns; team org members read what their role,
 * teams, and grants give them. An execute-only grant lists the package but
 * does not open its source.
 */
export async function viewerCanReadSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	return savedPackageViewerAllows(
		await loadSavedPackageViewerAccess(input),
		'package:read',
		input,
	)
}

/**
 * Whether a signed-in person may change a saved package from the account UI
 * (settings, publish, delete). They must belong to the owning org and hold
 * `package:write` on the package there — the same org binding used for write
 * APIs, not signup-org equality.
 */
export async function viewerCanManageSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	return savedPackageViewerAllows(
		await loadSavedPackageViewerAccess(input),
		'package:write',
		input,
	)
}

export type SavedPackageViewerAccess = {
	access: EffectivePermissions
	binding: OrgBinding
}

/**
 * The viewer's compiled access in the org that owns a saved package, or null
 * when they are signed out or not bound to that org. Load it once and check
 * every flag with {@link savedPackageViewerAllows} so one page load compiles
 * (and reads the org `access_epoch`) once.
 */
export async function loadSavedPackageViewerAccess(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
}): Promise<SavedPackageViewerAccess | null> {
	if (!input.viewer) return null
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return null
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	})
	return { access, binding }
}

/** Whether loaded viewer access holds a package permission on `packageId`. */
export function savedPackageViewerAllows(
	resolved: SavedPackageViewerAccess | null,
	permission: OrgPermission,
	input: { ownerId: string; packageId: string },
): boolean {
	if (!resolved) return false
	return checkPermission(
		resolved.access,
		permission,
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}

/**
 * Whether loaded viewer access may run the org's hosted package app. With
 * `appId`, only a grant on that app (or org-wide) counts.
 */
export function savedPackageViewerMayRunApp(
	resolved: SavedPackageViewerAccess | null,
	input: { ownerId: string; appId?: string | null },
): boolean {
	if (!resolved) return false
	const appId = input.appId?.trim()
	return checkPermission(
		resolved.access,
		'app:execute',
		appId
			? {
					type: 'app',
					id: appId,
					orgId: ownerIdFromStored(input.ownerId),
				}
			: undefined,
	).allowed
}

export async function viewerCanPublishSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	return savedPackageViewerAllows(
		await loadSavedPackageViewerAccess(input),
		'package:publish',
		input,
	)
}

export async function viewerCanDeleteSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	return savedPackageViewerAllows(
		await loadSavedPackageViewerAccess(input),
		'package:delete',
		input,
	)
}

/** Whether a signed-in person may change who can use the package (Collaborators). */
export async function viewerCanManageSavedPackageAccess(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	return savedPackageViewerAllows(
		await loadSavedPackageViewerAccess(input),
		'package:manage_access',
		input,
	)
}

/** Org Owner or Admin role on the package's owning org (personal or team). */
export async function viewerIsSavedPackageOrgOwner(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
}): Promise<boolean> {
	const resolved = await loadSavedPackageViewerAccess(input)
	return (
		resolved?.binding.role === 'owner' || resolved?.binding.role === 'admin'
	)
}

/**
 * Whether a signed-in person may run a hosted package app owned by this org,
 * asked as the person themselves (a session: no profile, no token scopes)
 * unless `credential` names the agent credential of a visit session.
 * Delegates to {@link checkAppVisitAccess} for the owning org's
 * `app:execute` decision, scoped to the app when `appId` is provided.
 */
export async function viewerCanExecutePackageApp(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	/** Saved package id when the concrete app is known. */
	appId?: string | null
	credential?: PackageAppSessionCredential | null
}): Promise<boolean> {
	if (!input.viewer) return false
	const access = await checkAppVisitAccess({
		env: input.env,
		callerRequest: visitSessionRequestFor(input.viewer, input.credential),
		ownerId: input.ownerId,
		appId: input.appId,
	})
	return access.allowed
}

/** A signed-in person's own request: a session narrows nothing. */
export function sessionRequestFor(
	viewer: Pick<McpUserContext, 'userId' | 'username'>,
) {
	return deriveRequestContext({ user: viewer, source: { kind: 'session' } })
}

/**
 * The request a package-app visit session acts as. A person's own session
 * narrows nothing; an agent's (opened with `appOpenLink`) keeps the token
 * scopes and profile chain of the credential that minted the link.
 */
export function visitSessionRequestFor(
	viewer: Pick<McpUserContext, 'userId' | 'username'>,
	credential: PackageAppSessionCredential | null | undefined,
): RequestContext {
	const request = sessionRequestFor(viewer)
	if (!credential) return request
	return {
		...request,
		credential: {
			kind: credential.kind,
			id: credential.id,
			orgId: request.org.id,
			scopes: credential.scopes,
			...(credential.profileId
				? {
						profileId: credential.profileId,
						profileChain: credential.profileChain ?? null,
						profileOrgId: credential.profileOrgId ?? request.org.id,
					}
				: {}),
		},
	}
}
