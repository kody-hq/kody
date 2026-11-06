import { expect, test } from 'vitest'
import {
	ComputeOverageLimitError,
	EntitlementLimitError,
	JobIntervalFloorError,
	computeOverageLimitErrorCode,
	entitlementLimitErrorCode,
	jobIntervalFloorErrorCode,
} from '#worker/entitlements/errors.ts'
import {
	entitlementStructuredContent,
	toMcpEntitlementMetadata,
} from './entitlement-metadata.ts'

test('entitlement metadata is only for known plan-limit and quota denials', () => {
	const upgradeHint = 'Upgrade at /@<slug>/-/billing.'
	const stockDenial = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'free',
		limit: 10,
		current: 10,
		upgradeHint,
	})
	const stockMetadata = {
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: 10,
		current: 10,
		upgradeHint,
	}
	// toStrictEqual pins the absence of the quota-only `used`/`remaining` keys.
	expect(toMcpEntitlementMetadata(stockDenial)).toStrictEqual(stockMetadata)
	expect(entitlementStructuredContent(stockDenial)).toEqual({
		entitlement: stockMetadata,
	})

	const quotaDenial = new EntitlementLimitError({
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
		limit: 100,
		current: 100,
		upgradeHint,
	})
	expect(toMcpEntitlementMetadata(quotaDenial)).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
		limit: 100,
		current: 100,
		upgradeHint,
		used: 100,
		remaining: 0,
		resetAt: quotaDenial.details.resetAt,
	})

	const intervalDenial = new JobIntervalFloorError({
		plan: 'free',
		minIntervalMs: 15 * 60 * 1000,
	})
	const intervalMetadata = {
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		minIntervalMs: 15 * 60 * 1000,
	}
	const computeDenial = new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 50,
		creditsStatus: 'add_credits',
	})
	const computeMetadata = {
		code: computeOverageLimitErrorCode,
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 50,
		creditsStatus: 'add_credits',
	}
	// Typed errors and their message-only rehydrations (after RPC) match.
	expect(toMcpEntitlementMetadata(new Error(stockDenial.message))).toEqual(
		stockMetadata,
	)
	for (const [denial, metadata] of [
		[intervalDenial, intervalMetadata],
		[computeDenial, computeMetadata],
	] as const) {
		expect(toMcpEntitlementMetadata(denial)).toMatchObject(metadata)
		expect(toMcpEntitlementMetadata(new Error(denial.message))).toMatchObject(
			metadata,
		)
	}

	expect(toMcpEntitlementMetadata(new Error('Boom'))).toBeUndefined()
	expect(entitlementStructuredContent(new Error('Boom'))).toEqual({})
})
