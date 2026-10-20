import { joinAppUrl } from '#worker/app-base-url.ts'
import { resolveFleetPackageErrorRateEnvironment } from '#worker/usage/fleet-package-error-rate.ts'
import {
	refreshFleetUsersAffected,
	type FleetUsersAffectedEnv,
} from '#worker/usage/fleet-users-affected.ts'
import {
	buildFleetUsersAffectedElevatedEvent,
	buildFleetUsersAffectedResolvedEvent,
	fleetUsersAffectedPublicStatusUrl,
} from '#worker/usage/fleet-users-affected-subscription-event.ts'
import { dispatchFleetUsersAffectedSubscriptionEvent } from '#worker/usage/fleet-users-affected-subscriptions.ts'

export type FleetUsersAffectedAlertResult =
	| Awaited<ReturnType<typeof refreshFleetUsersAffected>>
	| {
			status: 'refreshed'
			action: 'elevate' | 'resolve'
			elevated: boolean
			notify: 'notified' | 'notify_failed'
	  }

/**
 * Fifteen-minute sweep: refresh users-affected metrics, debounce elevate /
 * resolve, and fan admin events once per transition. Operator notifier
 * packages should page on elevated and send a resolved notice on resolve.
 */
export async function refreshFleetUsersAffectedAndMaybeAlert(input: {
	env: FleetUsersAffectedEnv
	now?: Date
}): Promise<FleetUsersAffectedAlertResult> {
	const now = input.now ?? new Date()
	const refreshed = await refreshFleetUsersAffected({
		env: input.env,
		now,
	})
	if (refreshed.status !== 'refreshed') return refreshed
	if (refreshed.action === 'none') return refreshed

	const insightsUrl = joinAppUrl({
		env: input.env,
		path: '/admin/insights',
	})
	const environment = resolveFleetPackageErrorRateEnvironment(input.env)
	const deploySha = input.env.CF_VERSION_METADATA?.id?.trim() || null
	const deployTimestamp =
		input.env.CF_VERSION_METADATA?.timestamp?.trim() || null

	try {
		if (refreshed.action === 'elevate') {
			await dispatchFleetUsersAffectedSubscriptionEvent({
				env: input.env as Pick<
					Env,
					'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
				>,
				event: buildFleetUsersAffectedElevatedEvent({
					eventId: `elevate:${refreshed.metrics.windowEnd}`,
					statusUrl: fleetUsersAffectedPublicStatusUrl,
					insightsUrl,
					environment,
					observedAt: now.toISOString(),
					incidentStartedAt:
						refreshed.state.incidentStartedAt ?? now.toISOString(),
					metrics: refreshed.metrics,
					baselineAffectedMedian: refreshed.state.baselineAffectedMedian,
					baselineFractionMedian: refreshed.state.baselineFractionMedian,
					deploySha,
					deployTimestamp,
				}),
			})
			console.warn('fleet-users-affected-elevated', {
				affectedUsers: refreshed.metrics.affectedUsers,
				activeUsers: refreshed.metrics.activeUsers,
				baselineAffectedMedian: refreshed.state.baselineAffectedMedian,
				dominantPackage: refreshed.metrics.dominantPackage?.kody_id ?? null,
			})
		} else {
			await dispatchFleetUsersAffectedSubscriptionEvent({
				env: input.env as Pick<
					Env,
					'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
				>,
				event: buildFleetUsersAffectedResolvedEvent({
					eventId: `resolve:${refreshed.metrics.windowEnd}`,
					statusUrl: fleetUsersAffectedPublicStatusUrl,
					insightsUrl,
					environment,
					observedAt: now.toISOString(),
					incidentStartedAt: refreshed.resolvedIncidentStartedAt,
					metrics: refreshed.metrics,
					baselineAffectedMedian: refreshed.state.baselineAffectedMedian,
					baselineFractionMedian: refreshed.state.baselineFractionMedian,
				}),
			})
			console.warn('fleet-users-affected-resolved', {
				affectedUsers: refreshed.metrics.affectedUsers,
				activeUsers: refreshed.metrics.activeUsers,
			})
		}
		return { ...refreshed, notify: 'notified' }
	} catch (error) {
		console.warn('fleet-users-affected-alert-failed', error)
		return { ...refreshed, notify: 'notify_failed' }
	}
}
