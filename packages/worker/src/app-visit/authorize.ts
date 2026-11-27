/**
 * Shared access checks for signed-in hosted package app visits.
 * See {@link checkAppVisitAccess} for permissions and
 * {@link authorizeAppVisit} for visit resolution and caching.
 */
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import type {
	OrgRole,
	RequestContext,
} from '@kody-internal/shared/request-context.ts'
import type { RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import {
	cachePackageAppAccessDecision,
	readCachedPackageAppAccessDecision,
	readOrgAccessEpoch,
} from '#app/package-app-access-decision.ts'
import {
	resolvePackageAppOrgOwnerByHandle,
	type PackageAppOrgOwner,
} from '#app/package-app-owner.ts'
import { needsPackageAppRunConsent } from '#app/package-app-run-consent.ts'
import {
	type AuthorizationError,
	checkPermission,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { loadOrgBindingForOrg, type OrgBinding } from '#worker/orgs/repo.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { resolvePackageAppBilling } from '#worker/package-runtime/package-app-billing.ts'

/**
 * The caller's request, re-bound to the org that owns the app: same person,
 * same credential (token scopes and profile chain), with the role they hold
 * in that org. A profile lives in the caller's org, so its home org rides
 * along for the chain lookup.
 */
export function appVisitRequest(
	callerRequest: RequestContext,
	binding: OrgBinding,
): RequestContext {
	const { credential } = callerRequest
	return {
		org: binding.org,
		actor: callerRequest.actor,
		attribution: callerRequest.attribution,
		credential: {
			...credential,
			orgId: binding.org.id,
			...(credential.profileId
				? { profileOrgId: credential.profileOrgId ?? callerRequest.org.id }
				: {}),
		},
		membership: binding.role ? { role: binding.role } : null,
	}
}

export type AppVisitAccess =
	| {
			allowed: true
			role: OrgRole | null
			/** The caller's request in the owning org. */
			request: RequestContext
			/** The acting profile, when the credential is bound to one. */
			profile: { id: string; name: string } | null
			/** Whether the caller also holds `permission` on that app. */
			holds: (permission: OrgPermission) => boolean
	  }
	| { allowed: false; error: AuthorizationError | null }

/**
 * Whether `callerRequest` may run an app owned by `ownerId`. With `appId`,
 * only access to that app counts; a grant on another app does not open it.
 * The owning org's `app:execute` decision includes any credential scopes
 * and profile chain on the request.
 */
export async function checkAppVisitAccess(input: {
	env: Env
	callerRequest: RequestContext
	ownerId: string
	/** Saved package id when the concrete app is known. */
	appId?: string | null
}): Promise<AppVisitAccess> {
	const actor = input.callerRequest.actor
	if (!actor) return { allowed: false, error: null }
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		actor.userId,
		input.ownerId,
	)
	if (!binding) return { allowed: false, error: null }
	const request = appVisitRequest(input.callerRequest, binding)
	const access = await computeEffectivePermissions({ env: input.env, request })
	const appId = input.appId?.trim()
	const resource = appId
		? {
				type: 'app' as const,
				id: appId,
				orgId: ownerIdFromStored(input.ownerId),
			}
		: undefined
	const decision = checkPermission(access, 'app:execute', resource)
	if (!decision.allowed) return { allowed: false, error: decision.error }
	const self = access.profileChain?.layers.find((layer) => layer.self)
	return {
		allowed: true,
		role: binding.role,
		request,
		profile: self ? { id: self.id, name: self.name } : null,
		holds: (permission) =>
			checkPermission(access, permission, resource).allowed,
	}
}

export type AppVisitAuthorization =
	| {
			kind: 'ok'
			owner: PackageAppOrgOwner
			/** The live package the slug names; null when the visit named none. */
			app: SavedPackageRecord | null
			/** True when the slug is a retired name for `app`. */
			retiredSlug: boolean
			/** The person, with their role in the owning org and any profile. */
			visitor: RuntimePackageAppVisitor
			/** The org billed for this visit's metered work (ADR 0095). */
			billedOrgId: OwnerId
			/** Whether this outside visitor needs "Run as me" confirmation. */
			needsRunConsent: boolean
			/** Org `access_epoch` the decision was made at. */
			epoch: number
	  }
	| { kind: 'not-found' }
	| {
			kind: 'forbidden'
			owner: PackageAppOrgOwner
			app: SavedPackageRecord | null
			/** Why, when the check ran for this request (not a cached refusal). */
			error: AuthorizationError | null
	  }

function settledValue<T>(result: PromiseSettledResult<T>): T {
	if (result.status === 'rejected') throw result.reason
	return result.value
}

/**
 * Resolve the org named by `ownerHandle` and decide whether `callerRequest`
 * may visit its app `appSlug`.
 *
 * A decision for a person with no profile and no token scopes is cached in KV
 * per org `access_epoch` (`package-app-access-decision.ts`): the epoch is read
 * first, so a decision computed concurrently with an access write is stored
 * under the epoch it may already be stale for, never under the new one. A
 * narrowed credential is always checked live, because profile grants and
 * token scopes do not bump the epoch.
 */
export async function authorizeAppVisit(input: {
	env: Env
	callerRequest: RequestContext
	ownerHandle: string
	/** App slug so app:execute is checked on that app, not any grant. */
	appSlug?: string | null
}): Promise<AppVisitAuthorization> {
	const { env, callerRequest } = input
	const owner = await resolvePackageAppOrgOwnerByHandle({
		env,
		handle: input.ownerHandle,
	})
	if (!owner) return { kind: 'not-found' }
	const slug = input.appSlug?.trim()
	// Independent reads run together; outcomes are taken in order, so a
	// failure or a miss resolves exactly as sequential reads would.
	const [lookupRead, epochRead] = await Promise.allSettled([
		slug
			? resolveSavedPackageForPackageAppSlug({
					db: env.APP_DB,
					userId: owner.userId,
					slug,
				})
			: null,
		readOrgAccessEpoch(env.APP_DB, owner.userId),
	])
	const lookup = settledValue(lookupRead)
	const app = lookup?.savedPackage ?? null
	const epoch = settledValue(epochRead)
	if (epoch === null) return { kind: 'not-found' }
	const actor = callerRequest.actor
	if (!actor) return { kind: 'forbidden', owner, app, error: null }

	const { credential } = callerRequest
	const profileId = credential.profileId ?? null
	const narrowed = profileId !== null || credential.scopes !== null
	const decisionScope = {
		env,
		orgId: owner.userId,
		epoch,
		visitorId: actor.userId,
		appId: app?.id ?? null,
		profileId,
	}
	let decision = narrowed
		? null
		: await readCachedPackageAppAccessDecision(decisionScope)
	let profile: { id: string; name: string } | null = null
	let error: AuthorizationError | null = null
	if (!decision) {
		const access = await checkAppVisitAccess({
			env,
			callerRequest,
			ownerId: owner.userId,
			appId: app?.id ?? null,
		})
		if (access.allowed) {
			decision = { allowed: true, role: access.role }
			profile = access.profile
		} else {
			decision = { allowed: false, role: null }
			error = access.error
		}
		if (!narrowed) cachePackageAppAccessDecision({ ...decisionScope, decision })
	}
	if (!decision.allowed) return { kind: 'forbidden', owner, app, error }

	const visitor: RuntimePackageAppVisitor = {
		userId: actor.userId,
		username: actor.username ?? '',
		role: decision.role,
		...(profile ? { profile } : {}),
		...(narrowed
			? {
					credential: {
						scopes: credential.scopes,
						...(profileId
							? {
									profileId,
									profileChain: credential.profileChain ?? null,
									profileOrgId: credential.profileOrgId ?? callerRequest.org.id,
								}
							: {}),
					},
				}
			: {}),
	}
	// Only a person with no role in the owning org pays either read.
	const [billing, needsRunConsent] = await Promise.all([
		resolvePackageAppBilling({
			db: env.APP_DB,
			ownerId: owner.userId,
			visitor,
			internetVisible: app?.isInternetVisible ?? false,
		}),
		app
			? needsPackageAppRunConsent({
					db: env.APP_DB,
					packageId: app.id,
					visitor,
				})
			: decision.role === null,
	])
	return {
		kind: 'ok',
		owner,
		app,
		retiredSlug: lookup?.retired === true,
		visitor,
		billedOrgId: billing?.orgId ?? owner.userId,
		needsRunConsent,
		epoch,
	}
}
