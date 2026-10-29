import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { packageAppOauthOwnerClaimLabels } from '#app/package-app-oauth-consent-copy.ts'
import {
	findLivePackageAppOauthGrantForApp,
	listLivePackageAppOauthGrantsForApp,
	revokePackageAppOauthGrantsForPersonApp,
} from '#app/package-app-oauth-grants.ts'
import { visitorNeedKeysOfScopes } from '#app/package-app-oauth-scopes.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { savedCredentialNeeds } from '#worker/credentials/credential-needs.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import {
	loadInvokeManifestBySourceId,
	resolveSavedPackage,
} from '#worker/package-invocations/module-artifacts.ts'
import {
	packageAppConnectedPeopleMaxPageSize,
	packageAppConnectedPeoplePageSize,
	type PackageAppConnectedPeopleView,
} from '#universal/package-app-connected-people.ts'
import { routes } from '#universal/routes.ts'

/** A package with an app that the caller may manage (`package:write`). */
export type ConnectedPeopleTarget = {
	orgId: string
	/** Lowercase org handle, as grants store it. */
	orgHandle: string
	package: { id: string; kodyId: string; name: string; sourceId: string }
}

export type ConnectedPeopleTargetResult =
	| { kind: 'ok'; target: ConnectedPeopleTarget }
	| { kind: 'not_found' }
	| { kind: 'forbidden' }
	| { kind: 'no_app' }

/**
 * The live package in the bound org. Not found when the caller cannot read it
 * (or it was deleted), forbidden without Manage (`package:write`), the same
 * permission as the package Settings tab.
 */
export async function loadConnectedPeopleTarget(input: {
	env: Env
	request: RequestContext
	packageIdOrKodyId: string
}): Promise<ConnectedPeopleTargetResult> {
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.request.org.id,
		packageIdOrKodyId: input.packageIdOrKodyId.trim(),
	})
	if (!savedPackage) return { kind: 'not_found' }
	const access = await computeEffectivePermissions({
		env: input.env,
		request: input.request,
	})
	const resource = packageResource({
		id: savedPackage.id,
		userId: savedPackage.userId,
		label: savedPackage.kodyId,
	})
	if (!checkPermission(access, 'package:read', resource).allowed) {
		return { kind: 'not_found' }
	}
	if (!checkPermission(access, 'package:write', resource).allowed) {
		return { kind: 'forbidden' }
	}
	const orgHandle = input.request.org.slug?.trim().toLowerCase()
	if (!savedPackage.hasApp || !orgHandle) return { kind: 'no_app' }
	return {
		kind: 'ok',
		target: {
			orgId: input.request.org.id,
			orgHandle,
			package: {
				id: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
				sourceId: savedPackage.sourceId,
			},
		},
	}
}

export function readConnectedPeoplePage(input: {
	page?: number | null
	pageSize?: number | null
}) {
	const page =
		input.page && Number.isInteger(input.page) && input.page > 0
			? input.page
			: 1
	const pageSize =
		input.pageSize && Number.isInteger(input.pageSize) && input.pageSize > 0
			? Math.min(input.pageSize, packageAppConnectedPeopleMaxPageSize)
			: packageAppConnectedPeoplePageSize
	return { page, pageSize }
}

async function loadVisitorNeedDescriptions(
	env: Env,
	target: ConnectedPeopleTarget,
) {
	const descriptions: Record<string, string> = {}
	try {
		const { manifest } = await loadInvokeManifestBySourceId({
			env,
			userId: target.orgId,
			sourceId: target.package.sourceId,
		})
		for (const [key, need] of Object.entries(
			manifest.kody.app?.visitorNeeds ?? {},
		)) {
			descriptions[key] = need.description
		}
	} catch {
		// Without the manifest, needs still read as credentials, never raw keys.
	}
	try {
		const needs = await loadPublishedCredentialNeeds({
			env,
			userId: target.orgId,
			sourceId: target.package.sourceId,
		})
		// Same precedence as the consent screen: executor needs win.
		for (const need of savedCredentialNeeds(needs)) {
			if (need.supplier === 'executor' && need.description) {
				descriptions[need.key] = need.description
			}
		}
	} catch {
		// Fall back to the visitorNeeds wording loaded above.
	}
	return descriptions
}

/** People signed in to the app, most recently used first. */
export async function listPackageAppConnectedPeople(input: {
	env: Env
	target: ConnectedPeopleTarget
	page?: number | null
	pageSize?: number | null
}): Promise<PackageAppConnectedPeopleView> {
	const { page, pageSize } = readConnectedPeoplePage(input)
	const { grants, total } = await listLivePackageAppOauthGrantsForApp({
		db: input.env.APP_DB,
		orgUsername: input.target.orgHandle,
		kodyId: input.target.package.kodyId,
		limit: pageSize,
		offset: (page - 1) * pageSize,
	})
	const needDescriptions = grants.some(
		(grant) => visitorNeedKeysOfScopes(grant.scopes).length > 0,
	)
		? await loadVisitorNeedDescriptions(input.env, input.target)
		: {}
	return {
		ok: true,
		package: {
			id: input.target.package.id,
			kodyId: input.target.package.kodyId,
			name: input.target.package.name,
		},
		people: grants.map((grant) => ({
			grantId: grant.id,
			username: grant.username,
			displayName: grant.displayName?.trim() || null,
			avatarUrl: grant.username
				? buildUserAvatarUrl({
						username: grant.username,
						avatarKey: grant.avatarKey,
					})
				: null,
			profileHref:
				grant.username && grant.profilePublic
					? routes.profile.href({ username: grant.username })
					: null,
			connectedAt: grant.createdAt,
			lastUsedAt: grant.lastUsedAt,
			allows: packageAppOauthOwnerClaimLabels(grant.scopes, needDescriptions),
		})),
		total,
		page,
		pageSize,
	}
}

/**
 * End one person's grant, the same as when they revoke it themselves: their
 * next call to the app is signed out. Their own credentials stay in their
 * account; only this app's link to them is removed. Audited.
 */
export async function revokePackageAppConnectedPerson(input: {
	env: Env
	target: ConnectedPeopleTarget
	grantId: string
	audit: { email?: string; ip?: string; path?: string }
}): Promise<boolean> {
	const db = input.env.APP_DB
	const grant = await findLivePackageAppOauthGrantForApp({
		db,
		orgUsername: input.target.orgHandle,
		kodyId: input.target.package.kodyId,
		grantId: input.grantId.trim(),
	})
	if (!grant) return false
	await revokePackageAppOauthGrantsForPersonApp({
		db,
		personId: grant.personId,
		orgUsername: grant.orgUsername,
		kodyId: grant.kodyId,
	})
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'oauth',
		action: 'package_app_grant_owner_revoke',
		result: 'success',
		email: input.audit.email,
		ip: input.audit.ip,
		path: input.audit.path,
		clientId: `${grant.orgUsername}/${grant.kodyId}`,
		reason: `grant:${grant.id}`,
	})
	return true
}
