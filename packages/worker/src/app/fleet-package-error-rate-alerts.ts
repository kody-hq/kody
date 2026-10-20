import { formatFleetPackageErrorRateConcentration } from '#universal/fleet-package-error-rate-concentration.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import {
	fleetPackageErrorRateAlertCooldownMinutes as defaultHourCooldownMinutes,
	refreshFleetPackageErrorRateSnapshot,
	writeFleetPackageErrorRateSnapshot,
	type FleetPackageErrorRateElevation,
	type FleetPackageErrorRateEnv,
	type FleetPackageErrorRateSnapshot,
} from '#worker/usage/fleet-package-error-rate.ts'
import {
	buildFleetPackageErrorRateElevatedEvent,
	fleetPackageErrorRatePublicStatusUrl,
	type FleetPackageErrorRateElevatedEvent,
	type FleetPackageErrorRateWindowKind,
} from '#worker/usage/fleet-package-error-rate-subscription-event.ts'
import { dispatchFleetPackageErrorRateSubscriptionEvent } from '#worker/usage/fleet-package-error-rate-subscriptions.ts'

export const fleetPackageErrorRateAlertKvKey =
	'ops-alert:fleet-package-error-rate:v1'

/** Hour-window pages stay quiet for six hours. */
export const fleetPackageErrorRateAlertCooldownMinutes =
	defaultHourCooldownMinutes
/** Day-window pages stay quiet for a full day (stops hourly re-pages). */
export const fleetPackageErrorRateDayAlertCooldownMinutes = 24 * 60

export type FleetPackageErrorRateAlertCooldownState = {
	version: 1
	alertedAtMs: number
	windowKind: FleetPackageErrorRateWindowKind
	windowEnd: string
	topOwnerUsername: string | null
	eventId: string
}

export type FleetPackageErrorRateRefreshResult =
	| {
			status: 'skipped'
			reason: 'missing-analytics-config' | 'query_failed' | 'no_kv'
	  }
	| {
			status: 'refreshed'
			elevated: false
	  }
	| {
			status: 'refreshed'
			elevated: true
			alert:
				| { status: 'notified'; eventId: string }
				| { status: 'cooldown'; eventId: string }
				| { status: 'skipped'; reason: 'notify_failed' }
	  }

/**
 * Recompute the fleet snapshot, then fan
 * `fleet.package_error_rate.elevated` to admin-owned packages when the
 * combined package-runtime error rate is rising. A concentrated spike
 * still pages the fleet; the event names the owning accounts.
 *
 * Day elevations use a 24h cooldown. Any elevation is also suppressed when
 * the same window end + top owner was already paged (stops hourly re-pages
 * when the event id string would otherwise change).
 */
export async function refreshFleetPackageErrorRateAndMaybeAlert(input: {
	env: FleetPackageErrorRateEnv
	now?: Date
	cooldownMinutes?: number
	dayCooldownMinutes?: number
}): Promise<FleetPackageErrorRateRefreshResult> {
	const now = input.now ?? new Date()
	const refreshed = await refreshFleetPackageErrorRateSnapshot({
		env: input.env,
		now,
	})
	if (refreshed.status !== 'refreshed') return refreshed
	if (!refreshed.elevation) {
		return { status: 'refreshed', elevated: false }
	}

	const event = buildElevatedEvent({
		env: input.env,
		snapshot: refreshed.snapshot,
		elevation: refreshed.elevation,
		observedAt: now,
	})
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'skipped', reason: 'no_kv' }

	const hourCooldownMinutes =
		input.cooldownMinutes ?? fleetPackageErrorRateAlertCooldownMinutes
	const dayCooldownMinutes =
		input.dayCooldownMinutes ?? fleetPackageErrorRateDayAlertCooldownMinutes
	const topOwnerUsername = topOwnerUsernameFromConcentration(
		event.concentration,
	)
	const lastAlert = await readAlertCooldownState(kv)
	if (
		shouldSuppressFleetPackageErrorRateAlert({
			now,
			lastAlert,
			windowKind: refreshed.elevation.kind,
			windowEnd: refreshed.elevation.comparison.recent.end,
			topOwnerUsername,
			hourCooldownMinutes,
			dayCooldownMinutes,
		})
	) {
		return {
			status: 'refreshed',
			elevated: true,
			alert: { status: 'cooldown', eventId: event.event_id },
		}
	}

	try {
		await dispatchFleetPackageErrorRateSubscriptionEvent({
			env: input.env as Pick<
				Env,
				'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
			>,
			event,
		})
		const snapshot: FleetPackageErrorRateSnapshot = {
			...refreshed.snapshot,
			lastAlertAt: now.toISOString(),
			lastAlertEventId: event.event_id,
		}
		await writeFleetPackageErrorRateSnapshot(kv, snapshot)
		// Keep one shared KV key readable for the longest cadence so an hour
		// page cannot expire day cooldown state early.
		const cooldownMinutes = Math.max(dayCooldownMinutes, hourCooldownMinutes)
		const cooldownState: FleetPackageErrorRateAlertCooldownState = {
			version: 1,
			alertedAtMs: now.getTime(),
			windowKind: refreshed.elevation.kind,
			windowEnd: refreshed.elevation.comparison.recent.end,
			topOwnerUsername,
			eventId: event.event_id,
		}
		await kv.put(
			fleetPackageErrorRateAlertKvKey,
			JSON.stringify(cooldownState),
			{ expirationTtl: (cooldownMinutes + 60) * 60 },
		)
		console.warn('fleet-package-error-rate-alerted', {
			eventId: event.event_id,
			window: event.trigger.window,
			reason: event.trigger.reason,
			checkedAt: now.toISOString(),
			concentration: event.concentration
				? formatFleetPackageErrorRateConcentration(event.concentration)
				: null,
		})
		return {
			status: 'refreshed',
			elevated: true,
			alert: { status: 'notified', eventId: event.event_id },
		}
	} catch (error) {
		console.warn('fleet-package-error-rate-alert-failed', error)
		return {
			status: 'refreshed',
			elevated: true,
			alert: { status: 'skipped', reason: 'notify_failed' },
		}
	}
}

export function shouldSuppressFleetPackageErrorRateAlert(input: {
	now: Date
	lastAlert: FleetPackageErrorRateAlertCooldownState | null
	windowKind: FleetPackageErrorRateWindowKind
	windowEnd: string
	topOwnerUsername: string | null
	hourCooldownMinutes?: number
	dayCooldownMinutes?: number
}) {
	const last = input.lastAlert
	if (!last) return false

	// Same completed window + same top owner: never re-page.
	if (
		last.windowKind === input.windowKind &&
		last.windowEnd === input.windowEnd &&
		(last.topOwnerUsername ?? null) === (input.topOwnerUsername ?? null)
	) {
		return true
	}

	const cooldownMinutes =
		input.windowKind === 'day'
			? (input.dayCooldownMinutes ??
				fleetPackageErrorRateDayAlertCooldownMinutes)
			: (input.hourCooldownMinutes ?? fleetPackageErrorRateAlertCooldownMinutes)
	return input.now.getTime() - last.alertedAtMs < cooldownMinutes * 60_000
}

export function parseFleetPackageErrorRateAlertCooldownState(
	value: unknown,
): FleetPackageErrorRateAlertCooldownState | null {
	// Legacy KV values were a millisecond timestamp string. After JSON.parse
	// that becomes a number; accept both so in-flight cooldowns survive deploy.
	if (typeof value === 'number' || typeof value === 'string') {
		const legacyMs = typeof value === 'number' ? value : Number(value)
		if (!Number.isFinite(legacyMs)) return null
		return {
			version: 1,
			alertedAtMs: legacyMs,
			windowKind: 'hour',
			windowEnd: '',
			topOwnerUsername: null,
			eventId: '',
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (record.version !== 1) return null
	if (typeof record.alertedAtMs !== 'number') return null
	if (record.windowKind !== 'hour' && record.windowKind !== 'day') return null
	if (typeof record.windowEnd !== 'string') return null
	if (typeof record.eventId !== 'string') return null
	return {
		version: 1,
		alertedAtMs: record.alertedAtMs,
		windowKind: record.windowKind,
		windowEnd: record.windowEnd,
		topOwnerUsername:
			typeof record.topOwnerUsername === 'string'
				? record.topOwnerUsername
				: null,
		eventId: record.eventId,
	}
}

function topOwnerUsernameFromConcentration(
	concentration: FleetPackageErrorRateElevatedEvent['concentration'],
) {
	const username = concentration?.owners[0]?.username?.trim()
	return username && username.length > 0 ? username : null
}

function buildElevatedEvent(input: {
	env: FleetPackageErrorRateEnv
	snapshot: FleetPackageErrorRateSnapshot
	elevation: FleetPackageErrorRateElevation
	observedAt: Date
}): FleetPackageErrorRateElevatedEvent {
	return buildFleetPackageErrorRateElevatedEvent({
		eventId: `${input.elevation.kind}:${input.elevation.comparison.recent.end}`,
		statusUrl: fleetPackageErrorRatePublicStatusUrl,
		insightsUrl: joinAppUrl({
			env: input.env,
			path: '/admin/insights',
		}),
		environment: input.snapshot.environment,
		observedAt: input.observedAt.toISOString(),
		window: input.elevation.kind,
		reason: input.elevation.reason,
		recent: input.elevation.comparison.recent,
		previous: input.elevation.comparison.previous,
		concentration: input.snapshot.concentration,
	})
}

async function readAlertCooldownState(kv: KVNamespace) {
	try {
		const raw = await kv.get(fleetPackageErrorRateAlertKvKey)
		if (raw == null) return null
		try {
			return parseFleetPackageErrorRateAlertCooldownState(JSON.parse(raw))
		} catch {
			return parseFleetPackageErrorRateAlertCooldownState(raw)
		}
	} catch (error) {
		console.debug('fleet-package-error-rate-cooldown-read-failed', error)
		return null
	}
}
