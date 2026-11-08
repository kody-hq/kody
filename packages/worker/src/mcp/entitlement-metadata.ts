import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	computeOverageLimitErrorCode,
	entitlementLimitErrorCode,
	isComputeOverageLimitError,
	isEntitlementLimitError,
	isJobIntervalFloorError,
	jobIntervalFloorErrorCode,
	parseComputeOverageLimitMessage,
	parseEntitlementLimitMessage,
	parseJobIntervalFloorMessage,
	type ComputeOverageLimitErrorDetails,
	type EntitlementLimitErrorDetails,
	type JobIntervalFloorErrorDetails,
} from '#worker/entitlements/errors.ts'
import { orgUsagePath } from '#universal/org-pages.ts'
import { isDailyEntitlementResource } from '#universal/plans.ts'

/**
 * Focused, machine-readable entitlement fields for MCP tool structured
 * content. Only known denial/quota fields — never secrets, prices, billing
 * records, or unrelated entitlements. Omitted from ordinary successes.
 */
export type McpEntitlementMetadata =
	| {
			code: typeof entitlementLimitErrorCode
			resource: EntitlementLimitErrorDetails['resource']
			plan: EntitlementLimitErrorDetails['plan']
			limit: number
			current: number
			upgradeHint: string
			used?: number
			remaining?: number
			window?: 'day' | 'week'
			/** Charged org slug when known. */
			orgSlug?: string
			/** Absolute meter reset instant (ISO) when the resource is windowed. */
			resetAt?: string
			/** Org Usage page for the charged org. */
			usagePath?: string
	  }
	| {
			code: typeof jobIntervalFloorErrorCode
			resource: 'scheduled_jobs'
			plan: JobIntervalFloorErrorDetails['plan']
			upgradeHint: string
			minIntervalMs: number
	  }
	| {
			code: typeof computeOverageLimitErrorCode
			resource: ComputeOverageLimitErrorDetails['resource']
			plan: ComputeOverageLimitErrorDetails['plan']
			limit: number
			current: number
			whatCounts: string
			upgradeHint: string
			creditsStatus: ComputeOverageLimitErrorDetails['creditsStatus']
	  }

export function toMcpEntitlementMetadata(
	error: unknown,
): McpEntitlementMetadata | undefined {
	if (isEntitlementLimitError(error)) {
		return toEntitlementLimitMetadata(error.details)
	}
	if (isComputeOverageLimitError(error)) {
		return toComputeOverageLimitMetadata(error.details)
	}
	if (isJobIntervalFloorError(error)) {
		return toJobIntervalMetadata(error.details)
	}

	const message = getErrorMessage(error)
	const entitlementDetails = parseEntitlementLimitMessage(message)
	if (entitlementDetails) return toEntitlementLimitMetadata(entitlementDetails)
	const computeDetails = parseComputeOverageLimitMessage(message)
	if (computeDetails) return toComputeOverageLimitMetadata(computeDetails)
	const intervalDetails = parseJobIntervalFloorMessage(message)
	if (intervalDetails) return toJobIntervalMetadata(intervalDetails)
	return undefined
}

/**
 * Spread onto MCP `structuredContent` only when the error is an entitlement
 * or plan-limit denial. Ordinary successes and unrelated errors stay
 * unchanged (no `entitlement` key).
 */
export function entitlementStructuredContent(error: unknown) {
	const entitlement = toMcpEntitlementMetadata(error)
	return entitlement ? { entitlement } : {}
}

function toEntitlementLimitMetadata(
	details: EntitlementLimitErrorDetails,
): McpEntitlementMetadata {
	const usagePath = details.orgSlug ? orgUsagePath(details.orgSlug) : undefined
	const metadata = {
		code: entitlementLimitErrorCode,
		resource: details.resource,
		plan: details.plan,
		limit: details.limit,
		current: details.current,
		upgradeHint: details.upgradeHint,
		...(details.window ? { window: details.window } : {}),
		...(details.orgSlug ? { orgSlug: details.orgSlug } : {}),
		...(details.resetAt ? { resetAt: details.resetAt } : {}),
		...(usagePath ? { usagePath } : {}),
	} as const
	if (!isDailyEntitlementResource(details.resource)) return metadata
	return {
		...metadata,
		used: details.current,
		remaining: Math.max(0, details.limit - details.current),
	}
}

function toComputeOverageLimitMetadata(
	details: ComputeOverageLimitErrorDetails,
): McpEntitlementMetadata {
	return {
		code: computeOverageLimitErrorCode,
		resource: details.resource,
		plan: details.plan,
		limit: details.limit,
		current: details.current,
		whatCounts: details.whatCounts,
		upgradeHint: details.upgradeHint,
		creditsStatus: details.creditsStatus,
	}
}

function toJobIntervalMetadata(
	details: JobIntervalFloorErrorDetails,
): McpEntitlementMetadata {
	return {
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: details.plan,
		upgradeHint: details.upgradeHint,
		minIntervalMs: details.minIntervalMs,
	}
}
