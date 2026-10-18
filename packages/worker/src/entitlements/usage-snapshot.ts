import { utcDayKey, utcWeekStart } from '@kody-internal/shared/date-keys.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	dailyEntitlementResources,
	entitlementResourceLabels,
	isDailyEntitlementResource,
	limitForResource,
	resolveEntitlementLimits,
	weeklyLimitForResource,
	type EntitlementResource,
	type PlanName,
	type UserEntitlement,
} from '#universal/plans.ts'
import {
	accountUsageEntitlementResources,
	buildEntitlementHowToReduce,
	entitlementResourceVisibility,
	type EntitlementResourceGroup,
	type EntitlementResourceVisibilityKind,
} from './resource-visibility.ts'
import {
	readCurrentEntitlementResourceUsage,
	readUserMeterEntitlementUsageSnapshot,
} from './service.ts'
import {
	formatStorageBucketKindSummary,
	listUserStorageBucketEstimates,
	summarizeStorageBucketEstimatesByKind,
	type StorageBucketKind,
} from '#worker/storage-buckets/service.ts'

export const entitlementUsageWarningThreshold = 0.8

export type EntitlementUsageWeekWindow = {
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
}

export type EntitlementUsageStorageByKind = {
	kind: StorageBucketKind
	label: string
	bytes: number
	count: number
}

export type EntitlementUsageSnapshotRow = {
	resource: EntitlementResource
	label: string
	group: EntitlementResourceGroup
	kind: EntitlementResourceVisibilityKind
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
	week?: EntitlementUsageWeekWindow
	/** Present on `storage_bytes` when inventoried buckets exist (no raw ids). */
	storageByKind?: Array<EntitlementUsageStorageByKind>
}

export type EntitlementUsageSnapshot = {
	plan: PlanName
	today: string
	weekStart: string
	resources: Array<EntitlementUsageSnapshotRow>
	warnings: Array<EntitlementUsageSnapshotRow>
}

const accountUsageDailyMeterResources = dailyEntitlementResources.filter(
	(resource) =>
		(accountUsageEntitlementResources as ReadonlyArray<string>).includes(
			resource,
		),
)

export async function readEntitlementUsageSnapshot(input: {
	db: D1Database
	env: Env
	usageUserId: OwnerId
	/** Effective entitlement: plan, seat pool, and limit overrides. */
	entitlement: UserEntitlement
	now?: Date
}): Promise<EntitlementUsageSnapshot> {
	const now = input.now ?? new Date()
	const { entitlement } = input
	const limits = resolveEntitlementLimits(entitlement, now)
	const weeklyResources = accountUsageDailyMeterResources.filter(
		(resource) => weeklyLimitForResource(limits, resource) !== null,
	)
	const nonMeterResources = accountUsageEntitlementResources.filter(
		(resource) =>
			!isDailyEntitlementResource(resource) && resource !== 'storage_bytes',
	)

	const [meterCounts, bucketEstimates, nonMeterUsages] = await Promise.all([
		readUserMeterEntitlementUsageSnapshot({
			db: input.db,
			env: input.env,
			userId: input.usageUserId,
			now,
			dailyResources: accountUsageDailyMeterResources,
			weeklyResources,
			includeStorageBytes: true,
		}),
		listUserStorageBucketEstimates({
			env: input.env,
			userId: input.usageUserId,
		}),
		Promise.all(
			nonMeterResources.map(async (resource) => {
				const visibility = entitlementResourceVisibility[resource]
				const current =
					visibility.kind === 'per_unit_max'
						? 0
						: await readCurrentEntitlementResourceUsage({
								db: input.db,
								env: input.env,
								userId: input.usageUserId,
								resource,
								now,
							})
				return { resource, current }
			}),
		),
	])

	const bucketEstimateTotal = bucketEstimates.reduce(
		(total, bucket) => total + (bucket.estimatedBytes ?? 0),
		0,
	)
	const nonMeterByResource = new Map(
		nonMeterUsages.map((entry) => [entry.resource, entry.current]),
	)

	const storageByKind = summarizeStorageBucketEstimatesByKind(bucketEstimates)
	const storageKindSummary = formatStorageBucketKindSummary(bucketEstimates)
	const resources = accountUsageEntitlementResources.map((resource) => {
		const visibility = entitlementResourceVisibility[resource]
		const current = resolveSnapshotCurrent({
			resource,
			visibilityKind: visibility.kind,
			meterCounts,
			bucketEstimateTotal,
			nonMeterByResource,
		})
		const week = resolveSnapshotWeekWindow({
			limit: weeklyLimitForResource(limits, resource),
			current: isDailyEntitlementResource(resource)
				? (meterCounts.weekly[resource] ?? 0)
				: 0,
		})
		const limit = limitForResource(limits, resource)
		// per_unit_max compares one candidate value (no accumulating
		// usage) and a zero limit means the plan has no allowance, so a
		// current/limit ratio is meaningless for both.
		const percentOfLimit =
			visibility.kind === 'per_unit_max' || limit === 0 ? null : current / limit
		const overEightyPercent =
			(percentOfLimit !== null &&
				percentOfLimit > entitlementUsageWarningThreshold) ||
			(week?.overEightyPercent ?? false)
		const whatCounts =
			resource === 'storage_bytes' && storageKindSummary
				? `${visibility.whatCounts} ${storageKindSummary}`
				: visibility.whatCounts
		return {
			resource,
			label: entitlementResourceLabels[resource],
			group: visibility.group,
			kind: visibility.kind,
			whatCounts,
			howToReduce: buildEntitlementHowToReduce(
				resource,
				entitlement.plan,
				entitlement.creditWallet,
			),
			current,
			limit,
			percentOfLimit,
			overEightyPercent,
			...(week ? { week } : {}),
			...(resource === 'storage_bytes' && storageByKind.length > 0
				? { storageByKind }
				: {}),
		}
	})
	return {
		plan: entitlement.plan,
		today: utcDayKey(now),
		weekStart: utcWeekStart(now),
		resources,
		warnings: resources.filter((row) => row.overEightyPercent),
	}
}

function resolveSnapshotCurrent(input: {
	resource: EntitlementResource
	visibilityKind: EntitlementResourceVisibilityKind
	meterCounts: Awaited<ReturnType<typeof readUserMeterEntitlementUsageSnapshot>>
	bucketEstimateTotal: number
	nonMeterByResource: Map<EntitlementResource, number>
}): number {
	if (input.visibilityKind === 'per_unit_max') return 0
	if (isDailyEntitlementResource(input.resource)) {
		return input.meterCounts.daily[input.resource] ?? 0
	}
	if (input.resource === 'storage_bytes') {
		return (input.meterCounts.storageBytes ?? 0) + input.bucketEstimateTotal
	}
	return input.nonMeterByResource.get(input.resource) ?? 0
}

function resolveSnapshotWeekWindow(input: {
	limit: number | null
	current: number
}): EntitlementUsageWeekWindow | undefined {
	const { limit, current } = input
	if (limit === null) return undefined
	const percentOfLimit = limit === 0 ? null : current / limit
	return {
		current,
		limit,
		percentOfLimit,
		overEightyPercent:
			percentOfLimit !== null &&
			percentOfLimit > entitlementUsageWarningThreshold,
	}
}
