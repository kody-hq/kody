import { memoizeForFeatureFlagExecution } from '#worker/feature-flags/execution-scope.ts'
import {
	isFeatureEnabled,
	isMissingFeatureFlagsTable,
} from '#worker/feature-flags/service.ts'
import { packageCredentialSuppliersFlagKey } from '#universal/feature-flags/registry.ts'

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
 * Memoizes per `orgId` on the caller's `request` object only. There is no
 * process-wide cache for the no-request path: a shared Map keyed by orgId
 * would leak enabled/disabled results across users and requests. Callers that
 * load many packages for one org should pass `request` and/or a precomputed
 * `supplierSemanticsEnabled` (see credential-detail listUsage / KODY-BV).
 */
export async function isPackageCredentialSuppliersEnabled(input: {
	db: D1Database
	orgId: string
	request?: object | null
}): Promise<boolean> {
	if (!input.request) return await evaluateForOrg(input)
	let flags = enabledByRequest.get(input.request)
	if (!flags) {
		flags = new Map()
		enabledByRequest.set(input.request, flags)
	}
	let result = flags.get(input.orgId)
	if (!result) {
		result = evaluateForOrg(input)
		flags.set(input.orgId, result)
	}
	try {
		return await result
	} catch (error) {
		flags.delete(input.orgId)
		throw error
	}
}
