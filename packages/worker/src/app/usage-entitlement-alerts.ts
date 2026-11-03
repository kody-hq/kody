import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	estimateDynamicWorkerUsd,
	fleetDynamicWorkerCostAlertUsd,
} from '#universal/dynamic-worker-cost.ts'
import type { AdminUsageEntitlementResource } from '#universal/loader-data.ts'
import {
	fleetRuntimeDurationAlertThresholdMs,
	loadFleetEntitlementCrossingSnapshots,
	type FleetEntitlementCrossingSnapshot,
} from '#worker/admin/fleet-usage-insights.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import {
	buildFleetDynamicWorkerCostCrossedEvent,
	buildFleetEntitlementResourceCrossedEvent,
	buildFleetRepeatedEntitlementCrossedEvent,
	buildFleetRuntimeDurationCrossedEvent,
	type FleetEntitlementCrossedEvent,
	type FleetEntitlementCrossingThreshold,
} from '#worker/usage/fleet-entitlement-crossing-subscription-event.ts'
import { dispatchFleetEntitlementCrossingSubscriptionEvent } from '#worker/usage/fleet-entitlement-crossing-subscriptions.ts'

/**
 * Hourly fleet usage / entitlement crossing check. The admin insights page
 * surfaces the same bounded sweep; this lane emits one
 * `fleet.entitlement.crossed` event per 80% or 100% crossing, per
 * first-over-threshold runtime-duration month, per first-over-threshold
 * unique Dynamic Worker cost month, and per first execute-cap train (three
 * of the last seven UTC days at 100%) so an admin package can notify
 * operators. Staying over the same threshold does not emit again.
 */

export const fleetEntitlementCrossingKvKeyPrefix =
	'fleet-entitlement-crossing:v1'
export const fleetEntitlementHitKvKeyPrefix = 'fleet-entitlement-hit:v1'
export const fleetEntitlementCrossingDailyClaimTtlSeconds = 36 * 60 * 60
export const fleetEntitlementCrossingStockClaimTtlSeconds = 30 * 24 * 60 * 60
export const fleetRuntimeDurationCrossingClaimTtlSeconds = 40 * 24 * 60 * 60
export const fleetRepeatedEntitlementCrossingClaimTtlSeconds = 8 * 24 * 60 * 60
export const fleetDynamicWorkerCostCrossingClaimTtlSeconds =
	fleetRuntimeDurationCrossingClaimTtlSeconds
export const fleetEntitlementHitClaimTtlSeconds = 8 * 24 * 60 * 60
export const fleetRepeatedEntitlementWindowDays = 7
export const fleetRepeatedEntitlementThresholdDays = 3
export const fleetRepeatedEntitlementResource =
	'execute_unique_workers_per_day' as const satisfies AdminUsageEntitlementResource
const dailyClaimLookbackDays = 3

type FleetCrossingClaim =
	| {
			kind: 'entitlement'
			threshold: FleetEntitlementCrossingThreshold
			resource: AdminUsageEntitlementResource
			day?: string
	  }
	| { kind: 'runtime_duration'; month: string }
	| {
			kind: 'repeated_entitlement'
			resource: AdminUsageEntitlementResource
	  }
	| { kind: 'dynamic_worker_cost'; month: string }

type UsageEntitlementAlertEnv = {
	APP_DB: D1Database
	APP_BASE_URL?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunUsageEntitlementAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export type FleetEntitlementCrossingEmitResult =
	| { status: 'skipped'; reason: 'no_kv' }
	| { status: 'no_pressure' }
	| { status: 'no_new_crossings'; issueCount: number }
	| { status: 'emitted'; issueCount: number; crossingCount: number }

export function isDailyEntitlementCrossingResource(
	resource: AdminUsageEntitlementResource,
) {
	return resource.endsWith('_per_day')
}

export function fleetEntitlementCrossingKvKey(input: {
	userId: string
	crossing: FleetCrossingClaim
}) {
	switch (input.crossing.kind) {
		case 'runtime_duration':
			return `${fleetEntitlementCrossingKvKeyPrefix}:${input.userId}:runtime_duration:${input.crossing.month}`
		case 'repeated_entitlement':
			return `${fleetEntitlementCrossingKvKeyPrefix}:${input.userId}:repeated_entitlement:${input.crossing.resource}`
		case 'dynamic_worker_cost':
			return `${fleetEntitlementCrossingKvKeyPrefix}:${input.userId}:dynamic_worker_cost:${input.crossing.month}`
		case 'entitlement': {
			const base = `${fleetEntitlementCrossingKvKeyPrefix}:${input.userId}:entitlement:${input.crossing.threshold}:${input.crossing.resource}`
			if (!isDailyEntitlementCrossingResource(input.crossing.resource)) {
				return base
			}
			if (!input.crossing.day) {
				throw new Error(
					`Daily fleet entitlement crossing key for ${input.crossing.resource} requires a UTC day`,
				)
			}
			return `${base}:${input.crossing.day}`
		}
		default: {
			const exhaustive: never = input.crossing
			throw new Error(
				`Unsupported fleet entitlement crossing: ${String(exhaustive)}`,
			)
		}
	}
}

export function fleetEntitlementHitKvKey(input: {
	userId: string
	resource: AdminUsageEntitlementResource
	day: string
}) {
	return `${fleetEntitlementHitKvKeyPrefix}:${input.userId}:${input.resource}:${input.day}`
}

export async function emitFleetEntitlementCrossingEvents(input: {
	env: UsageEntitlementAlertEnv
	now?: Date
	runtimeDurationThresholdMs?: number
}): Promise<FleetEntitlementCrossingEmitResult> {
	const now = input.now ?? new Date()
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'skipped', reason: 'no_kv' }

	const runtimeDurationThresholdMs =
		input.runtimeDurationThresholdMs ?? fleetRuntimeDurationAlertThresholdMs
	const snapshots = await loadFleetEntitlementCrossingSnapshots({
		db: input.env.APP_DB,
		env: input.env as Env,
		now,
	})
	if (snapshots.length === 0) return { status: 'no_pressure' }

	const insightsUrl = joinAppUrl({
		env: input.env,
		path: '/admin/insights',
	})
	const usersUrl = joinAppUrl({
		env: input.env,
		path: '/admin/users',
	})
	const pending: Array<FleetEntitlementCrossedEvent> = []
	let issueCount = 0
	for (const snapshot of snapshots) {
		const result = await collectCrossingsForSnapshot({
			kv,
			snapshot,
			now,
			runtimeDurationThresholdMs,
			insightsUrl,
			usersUrl,
		})
		issueCount += result.issueCount
		pending.push(...result.pending)
	}

	if (pending.length === 0) {
		return issueCount === 0
			? { status: 'no_pressure' }
			: { status: 'no_new_crossings', issueCount }
	}

	let crossingCount = 0
	for (const event of pending) {
		try {
			await dispatchFleetEntitlementCrossingSubscriptionEvent({
				env: input.env as Pick<
					Env,
					'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
				>,
				event,
			})
		} catch (error) {
			console.warn('fleet-entitlement-crossing-dispatch-failed', {
				kind: event.kind,
				userId: event.user.id,
				error,
			})
			continue
		}
		await claimCrossing({ kv, event, now })
		crossingCount += 1
	}

	if (crossingCount === 0) {
		return { status: 'no_new_crossings', issueCount }
	}

	console.warn('fleet-entitlement-crossing-emitted', {
		issueCount,
		crossingCount,
	})
	return { status: 'emitted', issueCount, crossingCount }
}

async function collectCrossingsForSnapshot(input: {
	kv: KVNamespace
	snapshot: FleetEntitlementCrossingSnapshot
	now: Date
	runtimeDurationThresholdMs: number
	insightsUrl: string
	usersUrl: string
}): Promise<{
	issueCount: number
	pending: Array<FleetEntitlementCrossedEvent>
}> {
	const pending: Array<FleetEntitlementCrossedEvent> = []
	let issueCount = 0
	const user = {
		id: input.snapshot.stableUserId,
		username: input.snapshot.username,
	}
	const observedAt = input.now.toISOString()

	for (const item of input.snapshot.entitlements) {
		if (item.percentOfLimit == null) continue
		const atReached = item.percentOfLimit >= 1
		const atApproaching = item.overEightyPercent && !atReached
		if (atReached || atApproaching) issueCount += 1

		if (atReached) {
			if (
				item.resource === fleetRepeatedEntitlementResource &&
				!input.snapshot.isAdmin
			) {
				await putExecuteReachedHit({
					kv: input.kv,
					userId: input.snapshot.stableUserId,
					day: utcDayKey(input.now),
					now: input.now,
				})
			}
			const reached = await unclaimedOrRefresh({
				kv: input.kv,
				userId: input.snapshot.stableUserId,
				crossing: {
					kind: 'entitlement',
					threshold: 'reached',
					resource: item.resource,
					day: utcDayKey(input.now),
				},
				now: input.now,
			})
			if (reached === 'unclaimed') {
				pending.push(
					buildFleetEntitlementResourceCrossedEvent({
						user,
						resource: item.resource,
						label: item.label,
						threshold: 'reached',
						current: item.current,
						limit: item.limit,
						percentOfLimit: item.percentOfLimit,
						insightsUrl: input.insightsUrl,
						usersUrl: input.usersUrl,
						observedAt,
					}),
				)
			} else {
				await putCrossingClaim({
					kv: input.kv,
					userId: input.snapshot.stableUserId,
					crossing: {
						kind: 'entitlement',
						threshold: 'approaching',
						resource: item.resource,
						day: utcDayKey(input.now),
					},
					claimedAt: String(input.now.getTime()),
				})
			}
			continue
		}

		await deleteCrossingClaims({
			kv: input.kv,
			userId: input.snapshot.stableUserId,
			crossing: {
				kind: 'entitlement',
				threshold: 'reached',
				resource: item.resource,
			},
			now: input.now,
		})

		if (atApproaching) {
			const approaching = await unclaimedOrRefresh({
				kv: input.kv,
				userId: input.snapshot.stableUserId,
				crossing: {
					kind: 'entitlement',
					threshold: 'approaching',
					resource: item.resource,
					day: utcDayKey(input.now),
				},
				now: input.now,
			})
			if (approaching === 'unclaimed') {
				pending.push(
					buildFleetEntitlementResourceCrossedEvent({
						user,
						resource: item.resource,
						label: item.label,
						threshold: 'approaching',
						current: item.current,
						limit: item.limit,
						percentOfLimit: item.percentOfLimit,
						insightsUrl: input.insightsUrl,
						usersUrl: input.usersUrl,
						observedAt,
					}),
				)
			}
			continue
		}

		await deleteCrossingClaims({
			kv: input.kv,
			userId: input.snapshot.stableUserId,
			crossing: {
				kind: 'entitlement',
				threshold: 'approaching',
				resource: item.resource,
			},
			now: input.now,
		})
	}

	const month = utcMonthKey(input.now)
	const runtimeOver =
		!input.snapshot.isAdmin &&
		input.snapshot.runtimeDurationMs > input.runtimeDurationThresholdMs
	if (runtimeOver) {
		issueCount += 1
		const runtime = await unclaimedOrRefresh({
			kv: input.kv,
			userId: input.snapshot.stableUserId,
			crossing: { kind: 'runtime_duration', month },
			now: input.now,
		})
		if (runtime === 'unclaimed') {
			pending.push(
				buildFleetRuntimeDurationCrossedEvent({
					user,
					totalDurationMs: input.snapshot.runtimeDurationMs,
					thresholdMs: input.runtimeDurationThresholdMs,
					insightsUrl: input.insightsUrl,
					usersUrl: input.usersUrl,
					observedAt,
				}),
			)
		}
	} else {
		await deleteCrossingClaims({
			kv: input.kv,
			userId: input.snapshot.stableUserId,
			crossing: { kind: 'runtime_duration', month },
			now: input.now,
		})
	}

	if (!input.snapshot.isAdmin) {
		const daysAtLimit = await countExecuteReachedHits({
			kv: input.kv,
			userId: input.snapshot.stableUserId,
			now: input.now,
		})
		const repeatedOver = daysAtLimit >= fleetRepeatedEntitlementThresholdDays
		if (repeatedOver) {
			issueCount += 1
			const repeated = await unclaimedOrRefresh({
				kv: input.kv,
				userId: input.snapshot.stableUserId,
				crossing: {
					kind: 'repeated_entitlement',
					resource: fleetRepeatedEntitlementResource,
				},
				now: input.now,
			})
			if (repeated === 'unclaimed') {
				pending.push(
					buildFleetRepeatedEntitlementCrossedEvent({
						user,
						resource: fleetRepeatedEntitlementResource,
						daysAtLimit,
						windowDays: fleetRepeatedEntitlementWindowDays,
						thresholdDays: fleetRepeatedEntitlementThresholdDays,
						insightsUrl: input.insightsUrl,
						usersUrl: input.usersUrl,
						observedAt,
					}),
				)
			}
		} else {
			await deleteCrossingClaims({
				kv: input.kv,
				userId: input.snapshot.stableUserId,
				crossing: {
					kind: 'repeated_entitlement',
					resource: fleetRepeatedEntitlementResource,
				},
				now: input.now,
			})
		}

		const thresholdUsd = fleetDynamicWorkerCostAlertUsd(input.snapshot.plan)
		const estimatedGrossUsd = estimateDynamicWorkerUsd(
			input.snapshot.uniqueWorkerDays,
		)
		const costOver = thresholdUsd != null && estimatedGrossUsd >= thresholdUsd
		if (costOver && thresholdUsd != null) {
			issueCount += 1
			const cost = await unclaimedOrRefresh({
				kv: input.kv,
				userId: input.snapshot.stableUserId,
				crossing: { kind: 'dynamic_worker_cost', month },
				now: input.now,
			})
			if (cost === 'unclaimed') {
				pending.push(
					buildFleetDynamicWorkerCostCrossedEvent({
						user,
						uniqueWorkerDays: input.snapshot.uniqueWorkerDays,
						estimatedGrossUsd,
						thresholdUsd,
						insightsUrl: input.insightsUrl,
						usersUrl: input.usersUrl,
						observedAt,
					}),
				)
			}
		} else {
			await deleteCrossingClaims({
				kv: input.kv,
				userId: input.snapshot.stableUserId,
				crossing: { kind: 'dynamic_worker_cost', month },
				now: input.now,
			})
		}
	}

	return { issueCount, pending }
}

async function unclaimedOrRefresh(input: {
	kv: KVNamespace
	userId: string
	crossing: FleetCrossingClaim
	now: Date
}): Promise<'unclaimed' | 'claimed'> {
	const key = fleetEntitlementCrossingKvKey({
		userId: input.userId,
		crossing: input.crossing,
	})
	const claimed = await input.kv.get(key)
	if (!claimed) return 'unclaimed'
	await putCrossingClaim({
		kv: input.kv,
		userId: input.userId,
		crossing: input.crossing,
		claimedAt: String(input.now.getTime()),
	})
	return 'claimed'
}

async function claimCrossing(input: {
	kv: KVNamespace
	event: FleetEntitlementCrossedEvent
	now: Date
}) {
	const claimedAt = String(input.now.getTime())
	switch (input.event.kind) {
		case 'entitlement':
			await putCrossingClaim({
				kv: input.kv,
				userId: input.event.user.id,
				crossing: {
					kind: 'entitlement',
					threshold: input.event.threshold,
					resource: input.event.resource,
					day: utcDayKey(input.now),
				},
				claimedAt,
			})
			if (input.event.threshold !== 'reached') return
			// Same climb already passed 80%. Claiming approaching here keeps a
			// later drop into the 80–99% band from emitting a second event.
			await putCrossingClaim({
				kv: input.kv,
				userId: input.event.user.id,
				crossing: {
					kind: 'entitlement',
					threshold: 'approaching',
					resource: input.event.resource,
					day: utcDayKey(input.now),
				},
				claimedAt,
			})
			return
		case 'runtime_duration':
			await putCrossingClaim({
				kv: input.kv,
				userId: input.event.user.id,
				crossing: {
					kind: 'runtime_duration',
					month: utcMonthKey(input.now),
				},
				claimedAt,
			})
			return
		case 'repeated_entitlement':
			await putCrossingClaim({
				kv: input.kv,
				userId: input.event.user.id,
				crossing: {
					kind: 'repeated_entitlement',
					resource: input.event.resource,
				},
				claimedAt,
			})
			return
		case 'dynamic_worker_cost':
			await putCrossingClaim({
				kv: input.kv,
				userId: input.event.user.id,
				crossing: {
					kind: 'dynamic_worker_cost',
					month: utcMonthKey(input.now),
				},
				claimedAt,
			})
			return
		default: {
			const exhaustive: never = input.event
			throw new Error(
				`Unsupported fleet entitlement crossing: ${String(exhaustive)}`,
			)
		}
	}
}

async function putCrossingClaim(input: {
	kv: KVNamespace
	userId: string
	crossing: FleetCrossingClaim
	claimedAt: string
}) {
	const key = fleetEntitlementCrossingKvKey({
		userId: input.userId,
		crossing: input.crossing,
	})
	const expirationTtl = crossingClaimTtlSeconds(input.crossing)
	try {
		await input.kv.put(key, input.claimedAt, { expirationTtl })
	} catch (error) {
		console.warn('fleet-entitlement-crossing-claim-failed', {
			key,
			error,
		})
	}
}

function crossingClaimTtlSeconds(crossing: FleetCrossingClaim) {
	switch (crossing.kind) {
		case 'runtime_duration':
			return fleetRuntimeDurationCrossingClaimTtlSeconds
		case 'dynamic_worker_cost':
			return fleetDynamicWorkerCostCrossingClaimTtlSeconds
		case 'repeated_entitlement':
			return fleetRepeatedEntitlementCrossingClaimTtlSeconds
		case 'entitlement':
			return isDailyEntitlementCrossingResource(crossing.resource)
				? fleetEntitlementCrossingDailyClaimTtlSeconds
				: fleetEntitlementCrossingStockClaimTtlSeconds
		default: {
			const exhaustive: never = crossing
			throw new Error(
				`Unsupported fleet entitlement crossing: ${String(exhaustive)}`,
			)
		}
	}
}

async function putExecuteReachedHit(input: {
	kv: KVNamespace
	userId: string
	day: string
	now: Date
}) {
	const key = fleetEntitlementHitKvKey({
		userId: input.userId,
		resource: fleetRepeatedEntitlementResource,
		day: input.day,
	})
	try {
		await input.kv.put(key, String(input.now.getTime()), {
			expirationTtl: fleetEntitlementHitClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('fleet-entitlement-hit-claim-failed', { key, error })
	}
}

async function countExecuteReachedHits(input: {
	kv: KVNamespace
	userId: string
	now: Date
}) {
	const days = recentUtcDayKeys(input.now, fleetRepeatedEntitlementWindowDays)
	const hits = await Promise.all(
		days.map((day) =>
			input.kv.get(
				fleetEntitlementHitKvKey({
					userId: input.userId,
					resource: fleetRepeatedEntitlementResource,
					day,
				}),
			),
		),
	)
	return hits.filter((hit) => hit != null).length
}

async function deleteCrossingClaims(input: {
	kv: KVNamespace
	userId: string
	crossing:
		| {
				kind: 'entitlement'
				threshold: FleetEntitlementCrossingThreshold
				resource: AdminUsageEntitlementResource
		  }
		| { kind: 'runtime_duration'; month: string }
		| {
				kind: 'repeated_entitlement'
				resource: AdminUsageEntitlementResource
		  }
		| { kind: 'dynamic_worker_cost'; month: string }
	now: Date
}) {
	if (
		input.crossing.kind === 'runtime_duration' ||
		input.crossing.kind === 'repeated_entitlement' ||
		input.crossing.kind === 'dynamic_worker_cost'
	) {
		await input.kv.delete(
			fleetEntitlementCrossingKvKey({
				userId: input.userId,
				crossing: input.crossing,
			}),
		)
		return
	}
	if (!isDailyEntitlementCrossingResource(input.crossing.resource)) {
		await input.kv.delete(
			fleetEntitlementCrossingKvKey({
				userId: input.userId,
				crossing: input.crossing,
			}),
		)
		return
	}
	const entitlementCrossing = input.crossing
	await Promise.all(
		recentUtcDayKeys(input.now).map((day) =>
			input.kv.delete(
				fleetEntitlementCrossingKvKey({
					userId: input.userId,
					crossing: {
						kind: 'entitlement',
						threshold: entitlementCrossing.threshold,
						resource: entitlementCrossing.resource,
						day,
					},
				}),
			),
		),
	)
}

function recentUtcDayKeys(now: Date, dayCount = dailyClaimLookbackDays) {
	const keys: Array<string> = []
	for (let daysAgo = 0; daysAgo < dayCount; daysAgo += 1) {
		keys.push(
			utcDayKey(new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)),
		)
	}
	return keys
}
