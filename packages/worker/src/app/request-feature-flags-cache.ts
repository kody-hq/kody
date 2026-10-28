/**
 * Per-request feature-flag evaluation cache.
 *
 * Used by `loadSessionInfo` (SSR app shell + `/session` refresh) so flag
 * evaluation happens at most once per HTTP request. Authenticated HTML pages
 * opt in via `readAuthenticatedAppUser({ prefetchFeatureFlags: true })` as
 * soon as the user id is known so `renderAppPage` awaits an already-in-flight
 * promise while the handler loads page data. MCP, package-app, and JSON API
 * auth paths do not start this load. Anonymous callers still receive registry
 * defaults without touching D1.
 *
 * Evaluation also records success-metric exposures for measured flags (see
 * `#worker/feature-flags/exposure.ts`), which is why authenticated
 * evaluation needs the caller's stable user id alongside the numeric one.
 *
 * On evaluation failure for an authenticated user, every flag is forced off
 * (fail closed) so a default-on registry flag cannot bypass a kill switch when
 * D1 is unavailable. Anonymous requests still use registry defaults.
 *
 * Org context: the org in the page path (`/@slug/...`), so per-org rows apply
 * on that org's pages for its members. Pages outside an org path have no org
 * context and ignore org rows.
 */

import { recordFeatureFlagExposures } from '#worker/feature-flags/exposure.ts'
import { getFeatureFlagEvaluationsForUser } from '#worker/feature-flags/service.ts'
import { getOrgBySlug } from '#worker/orgs/repo.ts'
import {
	featureFlagDefinitions,
	featureFlagKeys,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'

export type EvaluatedFeatureFlags = Record<FeatureFlagKey, boolean>

export type FeatureFlagRequestUser = {
	userId: number
	stableUserId: string
}

const requestFeatureFlagsStore = new WeakMap<
	Request,
	Map<string, Promise<EvaluatedFeatureFlags>>
>()

const orgPathPattern = /^\/@([^/]+)(?:\/|$)/

/** Org slug of an org-scoped page path (`/@slug/...`), else null. */
export function featureFlagOrgSlugFromPathname(pathname: string) {
	const match = orgPathPattern.exec(pathname)
	if (!match?.[1]) return null
	try {
		return decodeURIComponent(match[1]).trim().toLowerCase() || null
	} catch {
		return null
	}
}

function requestPathname(request: Request) {
	try {
		return new URL(request.url).pathname
	} catch {
		return '/'
	}
}

function defaultFeatureFlags(): EvaluatedFeatureFlags {
	const flags = {} as EvaluatedFeatureFlags
	for (const definition of featureFlagDefinitions) {
		flags[definition.key] = definition.defaultEnabled
	}
	return flags
}

function disabledFeatureFlags(): EvaluatedFeatureFlags {
	const flags = {} as EvaluatedFeatureFlags
	for (const key of featureFlagKeys) {
		flags[key] = false
	}
	return flags
}

async function resolveRequestFeatureFlags(
	env: Env,
	user: FeatureFlagRequestUser | null,
	orgSlug: string | null,
): Promise<EvaluatedFeatureFlags> {
	if (user === null) {
		return defaultFeatureFlags()
	}
	try {
		const org = orgSlug ? await getOrgBySlug(env.APP_DB, orgSlug) : null
		const evaluations = await getFeatureFlagEvaluationsForUser(
			env.APP_DB,
			user.userId,
			org ? { orgId: org.id } : null,
		)
		await recordFeatureFlagExposures(env, {
			stableUserId: user.stableUserId,
			evaluations,
		})
		const flags = {} as EvaluatedFeatureFlags
		for (const key of featureFlagKeys) {
			flags[key] = evaluations[key].enabled
		}
		return flags
	} catch (error) {
		console.error('Failed to load feature flags for authenticated user:', error)
		return disabledFeatureFlags()
	}
}

/**
 * `pathname` is the page being rendered when it differs from `request.url`
 * (the shell server function); it supplies the org context.
 */
export function loadRequestFeatureFlags(
	request: Request,
	env: Env,
	user: FeatureFlagRequestUser | null,
	pathname: string = requestPathname(request),
): Promise<EvaluatedFeatureFlags> {
	const orgSlug = featureFlagOrgSlugFromPathname(pathname)
	let byOrg = requestFeatureFlagsStore.get(request)
	if (!byOrg) {
		byOrg = new Map()
		requestFeatureFlagsStore.set(request, byOrg)
	}
	const cacheKey = orgSlug ?? ''
	let promise = byOrg.get(cacheKey)
	if (!promise) {
		promise = resolveRequestFeatureFlags(env, user, orgSlug)
		byOrg.set(cacheKey, promise)
	}
	return promise
}

/**
 * Start flag evaluation for an authenticated first-party HTML render so
 * `loadSessionInfo` can await an already-in-flight promise. Callers opt in
 * explicitly. No-ops for test stubs whose D1 fake has no `prepare`/`batch`.
 */
export function prefetchRequestFeatureFlagsForHtmlPage(
	request: Request,
	env: Env,
	user: FeatureFlagRequestUser,
): void {
	if (
		typeof env.APP_DB?.prepare !== 'function' ||
		typeof env.APP_DB.batch !== 'function'
	) {
		return
	}
	// Overlap flag evaluation with page-data loading. `loadSessionInfo`
	// awaits the same cached promise; the rejection handler is so a
	// prefetch that never reaches a render cannot become unhandled.
	void loadRequestFeatureFlags(request, env, user).then(undefined, () => {})
}

/** True when this request already resolved (and recorded) feature-flag exposures. */
export function hasResolvedRequestFeatureFlags(request: Request): boolean {
	return requestFeatureFlagsStore.has(request)
}
