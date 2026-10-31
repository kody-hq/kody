import { memoizeForFeatureFlagExecution } from '#worker/feature-flags/execution-scope.ts'
import {
	isFeatureEnabled,
	isMissingFeatureFlagsTable,
} from '#worker/feature-flags/service.ts'
import { packageCredentialSuppliersFlagKey } from '#universal/feature-flags/registry.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

const enabledByRequest = new WeakMap<object, Map<string, Promise<boolean>>>()

async function evaluateForOrg(input: {
	db: D1Database
	orgId: string
}): Promise<boolean> {
	const owner = await memoizeForFeatureFlagExecution(
		`org-owner:${input.orgId}`,
		() =>
			input.db
				.prepare(
					`SELECT u.id
					 FROM org_memberships m
					 INNER JOIN users u ON u.stable_user_id = m.user_id
					 WHERE m.org_id = ? AND m.role = 'owner'
					   AND m.deleted_at IS NULL AND u.deleted_at IS NULL
					 ORDER BY u.id
					 LIMIT 1`,
				)
				.bind(input.orgId)
				.first<{ id: number }>(),
	)
	try {
		return await isFeatureEnabled(
			input.db,
			packageCredentialSuppliersFlagKey,
			owner?.id ?? null,
			{ orgId: input.orgId },
		)
	} catch (error) {
		if (isMissingFeatureFlagsTable(error)) return false
		throw error
	}
}

/**
 * How long one org's supplier-flag answer is reused across requests. Same
 * 15 s window as `callerFeatureFlagEvaluationTtlMs` and the package freshness
 * tier, so a flag flip reaches package apps within one freshness window.
 */
export const packageCredentialSuppliersFlagTtlMs = 15_000

/**
 * The answer depends only on `orgId` (evaluated as the org's owner), never on
 * the viewer, so an org-keyed cache cannot leak one visitor's answer to
 * another. Failures are not cached.
 */
function createEnabledByOrgCache() {
	return new PromiseLruCache<boolean>({
		ttlMs: packageCredentialSuppliersFlagTtlMs,
		limit: 1000,
	})
}

let enabledByOrg = createEnabledByOrgCache()

export function resetPackageCredentialSuppliersFlagCacheForTests() {
	enabledByOrg = createEnabledByOrgCache()
}

/**
 * Reused across requests per `orgId` for {@link packageCredentialSuppliersFlagTtlMs}
 * (package-app serve calls this on every request), and memoized on the
 * caller's `request` object so one request never sees two answers. Callers
 * that load many packages for one org can still pass a precomputed
 * `supplierSemanticsEnabled` (see credential-detail listUsage / KODY-BV).
 */
export async function isPackageCredentialSuppliersEnabled(input: {
	db: D1Database
	orgId: string
	request?: object | null
}): Promise<boolean> {
	const evaluate = () =>
		enabledByOrg.getOrCreate({
			cacheKey: input.orgId,
			create: () => evaluateForOrg(input),
		})
	if (!input.request) return await evaluate()
	let flags = enabledByRequest.get(input.request)
	if (!flags) {
		flags = new Map()
		enabledByRequest.set(input.request, flags)
	}
	let result = flags.get(input.orgId)
	if (!result) {
		result = evaluate()
		flags.set(input.orgId, result)
	}
	try {
		return await result
	} catch (error) {
		flags.delete(input.orgId)
		throw error
	}
}
