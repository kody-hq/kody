import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import {
	nonInteractiveTriggerOf,
	type NonInteractiveTriggerType,
} from '#worker/authorization/authorize.ts'
import {
	type PermissionString,
	type RoleName,
	userHasPermission,
	userHasRole,
} from '#universal/permissions.ts'
import { recordFeatureFlagExposures } from '#worker/feature-flags/exposure.ts'
import {
	type FeatureFlagKey,
	featureFlagKeys,
} from '#universal/feature-flags/registry.ts'
import {
	getFeatureFlagEvaluationsForUser,
	type FeatureFlagEvaluation,
} from '#worker/feature-flags/service.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import {
	type McpAuthDenialReason,
	recordMcpAuthDenial,
} from '#mcp/auth-audit.ts'
import { type BuiltCapabilityRegistry } from './build-capability-registry.ts'
import {
	requiresSiteAccess,
	type SiteAccessActorTrigger,
} from './triggered-site-access.ts'
import { type Capability, type CapabilitySpec } from './types.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

type CapabilityAccessRequirement = Pick<
	Capability | CapabilitySpec,
	'name' | 'requiredRole' | 'requiredPermission' | 'featureFlag'
>

export type CallerFeatureFlags = Readonly<Record<FeatureFlagKey, boolean>>

type McpUserAccessContext = {
	roles?: Array<string>
	permissions?: Array<string>
} | null

function getUserAccessContext(callerContext: McpCallerContext) {
	return callerContext.user ?? null
}

function hasRequiredRole(user: McpUserAccessContext, role: RoleName) {
	return userHasRole({ roles: (user?.roles ?? []) as Array<RoleName> }, role)
}

export function callerHasRole(
	callerContext: McpCallerContext,
	role: RoleName,
): boolean {
	return hasRequiredRole(getUserAccessContext(callerContext), role)
}

function hasRequiredPermission(
	user: McpUserAccessContext,
	permission: PermissionString,
) {
	return userHasPermission(
		{ permissions: (user?.permissions ?? []) as Array<PermissionString> },
		permission,
	)
}

function disabledFeatureFlags(): CallerFeatureFlags {
	return Object.fromEntries(
		featureFlagKeys.map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>
}

async function resolveFeatureFlagUserId(
	db: D1Database,
	stableUserId: string,
): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ id: number }>()
	return row?.id ?? null
}

type CallerFeatureFlagResolution =
	| {
			status: 'ok'
			stableUserId: string
			evaluations: Record<FeatureFlagKey, FeatureFlagEvaluation>
	  }
	| { status: 'anonymous' | 'unresolved' }
	| { status: 'failed' }

/**
 * Cross-request evaluation cache for stateless `/mcp` (a new caller context
 * every HTTP request). Long enough to cover a burst of tools/call round
 * trips, short enough that a kill switch lands on the next requests after
 * this window. Failures are not cached.
 */
export const callerFeatureFlagEvaluationTtlMs = 15_000

const callerFeatureFlagEvaluationCaches = new WeakMap<
	D1Database,
	PromiseLruCache<CallerFeatureFlagResolution>
>()

function callerFeatureFlagEvaluationCache(db: D1Database) {
	let cache = callerFeatureFlagEvaluationCaches.get(db)
	if (!cache) {
		cache = new PromiseLruCache<CallerFeatureFlagResolution>({
			ttlMs: callerFeatureFlagEvaluationTtlMs,
			limit: 500,
		})
		callerFeatureFlagEvaluationCaches.set(db, cache)
	}
	return cache
}

const callerFeatureFlagResolutions = new WeakMap<
	McpCallerContext,
	Promise<CallerFeatureFlagResolution>
>()

const callerFeatureFlagMaps = new WeakMap<
	McpCallerContext,
	Promise<CallerFeatureFlags>
>()

class UnresolvedFeatureFlagUser extends Error {
	constructor() {
		super('feature flag user is unresolved')
		this.name = 'UnresolvedFeatureFlagUser'
	}
}

async function loadFreshCallerFeatureFlagResolution(
	env: Env,
	stableUserId: string,
	orgId: string | null,
): Promise<CallerFeatureFlagResolution> {
	const userId = await resolveFeatureFlagUserId(env.APP_DB, stableUserId)
	// Do not cache this. A users row can appear in the same TTL window.
	if (userId === null) throw new UnresolvedFeatureFlagUser()
	const evaluations = await getFeatureFlagEvaluationsForUser(
		env.APP_DB,
		userId,
		orgId ? { orgId } : null,
	)
	await recordFeatureFlagExposures(env, {
		stableUserId,
		evaluations,
	})
	return { status: 'ok', stableUserId, evaluations }
}

async function loadCallerFeatureFlagResolution(
	env: Env,
	callerContext: McpCallerContext,
): Promise<CallerFeatureFlagResolution> {
	let promise = callerFeatureFlagResolutions.get(callerContext)
	if (!promise) {
		promise = (async (): Promise<CallerFeatureFlagResolution> => {
			if (!env.APP_DB) return { status: 'anonymous' }
			const stableUserId = callerContext.user?.userId?.trim()
			if (!stableUserId) return { status: 'anonymous' }
			// Org rows apply to the org the call runs in (the request
			// context org), so the same person can see different values in
			// different orgs and the cache is keyed by both.
			const orgId = callerContext.request?.org.id?.trim() || null
			try {
				return await callerFeatureFlagEvaluationCache(env.APP_DB).getOrCreate({
					cacheKey: orgId ? `${stableUserId}\u0000${orgId}` : stableUserId,
					create: () =>
						loadFreshCallerFeatureFlagResolution(env, stableUserId, orgId),
				})
			} catch (error) {
				if (error instanceof UnresolvedFeatureFlagUser) {
					return { status: 'unresolved' }
				}
				return { status: 'failed' }
			}
		})()
		callerFeatureFlagResolutions.set(callerContext, promise)
	}
	return await promise
}

function flagsFromResolution(
	resolution: CallerFeatureFlagResolution,
): CallerFeatureFlags {
	if (resolution.status !== 'ok') return disabledFeatureFlags()
	return Object.fromEntries(
		featureFlagKeys.map((key) => [key, resolution.evaluations[key].enabled]),
	) as Record<FeatureFlagKey, boolean>
}

/**
 * Full flag evaluations (enabled + assignment source). Shares the caller
 * context and the short TTL cache with `resolveCallerFeatureFlags`, including
 * the exposure write when that cache entry is filled.
 */
export async function resolveCallerFeatureFlagEvaluations(
	env: Env,
	callerContext: McpCallerContext,
): Promise<Record<FeatureFlagKey, FeatureFlagEvaluation> | null> {
	const resolution = await loadCallerFeatureFlagResolution(env, callerContext)
	return resolution.status === 'ok' ? resolution.evaluations : null
}

/**
 * True when this request's flag read threw (D1 or evaluation). Anonymous
 * callers and unknown stable ids are fail-closed, not failures. A failure
 * must refuse execute before any worker loads.
 */
export async function callerFeatureFlagEvaluationFailed(
	env: Env,
	callerContext: McpCallerContext,
): Promise<boolean> {
	const resolution = await loadCallerFeatureFlagResolution(env, callerContext)
	return resolution.status === 'failed'
}

/**
 * Resolve the caller's evaluated feature-flag map. Call sites on the same
 * `McpCallerContext` share one read. Stateless `/mcp` builds a new context
 * per HTTP request, so evaluations are also cached per stable user id for
 * {@link callerFeatureFlagEvaluationTtlMs}. Exposures are written when that
 * cache entry is filled, not once per call site and not once per request
 * inside the window. Counts are lower than the old per-call-site writes and
 * are the accurate assignment record.
 *
 * Fail-closed rules: anonymous callers, authenticated callers whose stable
 * id cannot be resolved to a `users.id`, and evaluation failures get every
 * flag off. Failures are not cached, so the next request retries.
 */
export async function resolveCallerFeatureFlags(
	env: Env,
	callerContext: McpCallerContext,
): Promise<CallerFeatureFlags> {
	let promise = callerFeatureFlagMaps.get(callerContext)
	if (!promise) {
		promise = loadCallerFeatureFlagResolution(env, callerContext).then(
			(resolution) => flagsFromResolution(resolution),
		)
		callerFeatureFlagMaps.set(callerContext, promise)
	}
	return await promise
}

/**
 * Whether site-admin role/permission checks should key on `request.actor`
 * (D1) instead of `callerContext.user.roles`.
 *
 * Enablement-backed runs (job, webhook, subscription, email) always defer:
 * the MCP user is the org's identity (`roles: ['user']`) and is not trusted
 * for site-admin. Package-app and unattended runs still fail closed on
 * caller roles.
 *
 * Background `jobRunNow` inherits a live-person credential, so it is not a
 * non-interactive trigger, but the MCP user is still the org when the job
 * belongs to a team org. Defer whenever a background run's actor is a
 * different person from the MCP user so admin tools stay visible and the
 * actor D1 gate can run (#3541 follow-up).
 */
export function shouldDeferSiteAccessToActor(
	callerContext: McpCallerContext,
): boolean {
	const trigger = nonInteractiveTriggerOf(callerContext.request)
	if (trigger) {
		const type: NonInteractiveTriggerType = trigger.type
		switch (type) {
			case 'job':
			case 'webhook':
			case 'subscription':
			case 'email':
				return true
			case 'package-app':
			case 'unattended':
				return false
			default: {
				const exhaustive: never = type
				throw new Error(
					`Unhandled non-interactive trigger: ${String(exhaustive)}`,
				)
			}
		}
	}
	if (callerContext.executionOrigin !== 'background') return false
	const actorId = callerContext.request?.actor?.userId
	const userId = callerContext.user?.userId
	if (!actorId || !userId) return false
	return String(actorId) !== String(userId)
}

/**
 * The actor-gate trigger when site-admin access defers to `request.actor`,
 * or null when the caller's roles are checked instead.
 */
export function siteAccessActorTriggerOf(
	callerContext: McpCallerContext,
): SiteAccessActorTrigger | null {
	if (!shouldDeferSiteAccessToActor(callerContext)) return null
	const trigger = nonInteractiveTriggerOf(callerContext.request)
	if (trigger) return trigger
	const request = callerContext.request
	if (!request?.actor) return null
	return {
		type: 'run-now',
		credentialId: request.credential.id,
	}
}

export function callerCanAccessCapability(
	callerContext: McpCallerContext,
	capability: CapabilityAccessRequirement,
	featureFlags?: CallerFeatureFlags | null,
) {
	const requiredRole = capability.requiredRole
	const requiredPermission = capability.requiredPermission
	const requiredFeatureFlag = capability.featureFlag
	if (!requiredRole && !requiredPermission && !requiredFeatureFlag) {
		return true
	}

	// Flag-gated capabilities also require an authenticated caller: flags are
	// evaluated per user, so there is no meaningful anonymous flag state.
	const user = getUserAccessContext(callerContext)
	if (!user) return false
	const deferSiteAccess =
		requiresSiteAccess(capability) &&
		shouldDeferSiteAccessToActor(callerContext)
	if (!deferSiteAccess) {
		if (requiredRole && !hasRequiredRole(user, requiredRole)) return false
		if (
			requiredPermission &&
			!hasRequiredPermission(user, requiredPermission)
		) {
			return false
		}
	}
	if (requiredFeatureFlag) {
		// Fail closed when the per-request flag map was not resolved.
		if (!featureFlags) return false
		if (featureFlags[requiredFeatureFlag] !== true) return false
	}
	return true
}

export async function assertCallerCanAccessCapability(
	callerContext: McpCallerContext,
	capability: CapabilityAccessRequirement,
	options: {
		featureFlags?: CallerFeatureFlags | null
		env?: Env
	} = {},
) {
	let featureFlags = options.featureFlags
	if (capability.featureFlag && featureFlags == null && options.env) {
		featureFlags = await resolveCallerFeatureFlags(options.env, callerContext)
	}

	if (callerCanAccessCapability(callerContext, capability, featureFlags)) {
		return
	}

	const user = getUserAccessContext(callerContext)
	const denial = describeCapabilityDenial(callerContext, user, capability)
	// A denial is the one signal we would have that a principal is walking the
	// capability surface, so it is recorded even though it is not an error.
	await recordMcpAuthDenial({
		db: options.env ? auditDatabaseFromEnv(options.env) : undefined,
		action: 'mcp_capability_denied',
		reason: denial.reason,
		email: callerContext.user?.email,
		path: capability.name,
	})
	throw new Error(denial.message)
}

function describeCapabilityDenial(
	callerContext: McpCallerContext,
	user: ReturnType<typeof getUserAccessContext>,
	capability: CapabilityAccessRequirement,
): { reason: McpAuthDenialReason; message: string } {
	if (!user) {
		return {
			reason: 'no_user',
			message: `Authenticated MCP user is required to execute capability "${capability.name}".`,
		}
	}
	const deferSiteAccess =
		requiresSiteAccess(capability) &&
		shouldDeferSiteAccessToActor(callerContext)
	if (!deferSiteAccess) {
		if (
			capability.requiredRole &&
			!hasRequiredRole(user, capability.requiredRole)
		) {
			return {
				reason: 'role',
				message: `MCP user lacks required role "${capability.requiredRole}" for capability "${capability.name}".`,
			}
		}
		if (
			capability.requiredPermission &&
			!hasRequiredPermission(user, capability.requiredPermission)
		) {
			return {
				reason: 'permission',
				message: `MCP user lacks required permission "${capability.requiredPermission}" for capability "${capability.name}".`,
			}
		}
	}
	if (capability.featureFlag) {
		return {
			reason: 'feature_flag',
			message: `MCP user lacks required feature flag "${capability.featureFlag}" for capability "${capability.name}".`,
		}
	}
	return {
		reason: 'denied',
		message: `MCP user cannot access capability "${capability.name}".`,
	}
}

export function filterCapabilityRegistryForCaller(
	registry: BuiltCapabilityRegistry,
	callerContext: McpCallerContext,
	featureFlags?: CallerFeatureFlags | null,
): BuiltCapabilityRegistry {
	const capabilityList = registry.capabilityList.filter((capability) =>
		callerCanAccessCapability(callerContext, capability, featureFlags),
	)
	if (capabilityList.length === registry.capabilityList.length) {
		return registry
	}

	return projectCapabilityRegistry(registry, capabilityList)
}

/**
 * Discovery surfaces (search, metaListCapabilities) hide package-locked MCP
 * servers the caller cannot use. Runtime execute keeps those capabilities so
 * an approved package export imported into execute can still dispatch; call
 * time assertCanUseMcpServer enforces the grant.
 */
export function filterCapabilityRegistryMcpServersForCaller(
	registry: BuiltCapabilityRegistry,
	visibleServerIds: ReadonlySet<string>,
): BuiltCapabilityRegistry {
	// Discovery callers and tests sometimes pass a partial registry (specs
	// only). Without a capabilityList there is nothing to hide.
	if (!Array.isArray(registry.capabilityList)) {
		return registry
	}
	const capabilityList = registry.capabilityList.filter((capability) => {
		if (capability.source !== 'mcp-server' || !capability.mcpServer) {
			return true
		}
		return visibleServerIds.has(capability.mcpServer.serverId)
	})
	if (capabilityList.length === registry.capabilityList.length) {
		return registry
	}
	return projectCapabilityRegistry(registry, capabilityList)
}

function projectCapabilityRegistry(
	registry: BuiltCapabilityRegistry,
	capabilityList: Array<Capability>,
): BuiltCapabilityRegistry {
	const allowedNames = new Set(
		capabilityList.map((capability) => capability.name),
	)
	const allowedDomains = new Set(
		capabilityList.map((capability) => capability.domain),
	)
	const capabilityDomains = registry.capabilityDomains.filter((domain) =>
		allowedDomains.has(domain.name),
	)
	const capabilityDomainDescriptionsByName = Object.fromEntries(
		Object.entries(registry.capabilityDomainDescriptionsByName).filter(
			([name]) => allowedDomains.has(name),
		),
	) as BuiltCapabilityRegistry['capabilityDomainDescriptionsByName']
	const capabilityMap = Object.fromEntries(
		Object.entries(registry.capabilityMap).filter(([, capability]) =>
			allowedNames.has(capability.name),
		),
	) as BuiltCapabilityRegistry['capabilityMap']
	const capabilitySpecs = Object.fromEntries(
		Object.entries(registry.capabilitySpecs).filter(([name]) =>
			allowedNames.has(name),
		),
	) as BuiltCapabilityRegistry['capabilitySpecs']
	const capabilityToolDescriptors = Object.fromEntries(
		Object.entries(registry.capabilityToolDescriptors).filter(([name]) =>
			allowedNames.has(name),
		),
	) as BuiltCapabilityRegistry['capabilityToolDescriptors']
	const capabilityHandlers = Object.fromEntries(
		Object.entries(registry.capabilityHandlers).filter(([name]) =>
			allowedNames.has(name),
		),
	) as BuiltCapabilityRegistry['capabilityHandlers']

	return {
		capabilityList,
		capabilityDomains,
		capabilityDomainDescriptionsByName,
		capabilityMap,
		capabilitySpecs,
		capabilityToolDescriptors,
		capabilityHandlers,
	}
}
