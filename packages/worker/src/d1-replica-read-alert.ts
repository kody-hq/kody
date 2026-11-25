import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { d1ReplicaReadsFlagKey } from '#worker/d1-replica-reads.ts'
import {
	buildD1ReplicaReadColoQuery,
	buildD1ReplicaReadTotalsQuery,
	parseD1ReplicaReadColos,
	parseD1ReplicaReadTotals,
	resolveD1ReplicaReadEventsDataset,
	type D1ReplicaReadColo,
	type D1ReplicaReadCounts,
} from '#worker/d1-replica-read-events.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { queryAnalyticsEngineSql } from '#worker/usage/aggregate-rollups.ts'

export const d1ReplicaReadAlertTopic = 'd1.replica_reads.alert'
export const d1ReplicaReadAlertWindowMinutes = 15
/** Retries over this share of replica reads page, once there is enough traffic. */
export const d1ReplicaReadAlertRetryRatePercent = 1
/** Below this many replica reads a handful of retries is noise, not a rate. */
export const d1ReplicaReadAlertMinReplicaReads = 200
/** Retries that page whatever the traffic. */
export const d1ReplicaReadAlertRetryBurst = 50
/** Document routes that failed in a request that read a replica. */
export const d1ReplicaReadAlertDocument500s = 3
export const d1ReplicaReadAlertCooldownMinutes = 60
/** A breach this soon after the last one continues the same incident. */
export const d1ReplicaReadAlertIncidentGapMinutes = 30
export const d1ReplicaReadAlertKvKey = 'ops-alert:d1-replica-reads:v1'
export const d1ReplicaReadAlertKillSwitch = `Set feature flag ${d1ReplicaReadsFlagKey} to enabled:false (Cole flips flags).`

export type D1ReplicaReadAlertTrigger =
	| 'retry_rate'
	| 'retry_burst'
	| 'document_500s'

export type D1ReplicaReadAlertState = {
	incidentKey: string
	notifiedAt: number
	lastBreachAt: number
}

export type D1ReplicaReadAlertDecision =
	| { action: 'below_threshold'; retryRatePercent: number }
	| {
			action: 'cooldown' | 'notify'
			retryRatePercent: number
			triggers: Array<D1ReplicaReadAlertTrigger>
			incidentKey: string
			nextState: D1ReplicaReadAlertState
	  }

export function d1ReplicaReadRetryRatePercent(counts: D1ReplicaReadCounts) {
	if (counts.replicaReads === 0) return 0
	return Math.round((counts.retries / counts.replicaReads) * 10_000) / 100
}

/** One card per incident: the UTC hour the incident's first breach was seen. */
export function d1ReplicaReadAlertIncidentKey(now: Date) {
	return `d1-replica-alert-${now.toISOString().slice(0, 13).replace('T', '-')}`
}

export function decideD1ReplicaReadAlert(input: {
	counts: D1ReplicaReadCounts
	state: D1ReplicaReadAlertState | null
	now: Date
}): D1ReplicaReadAlertDecision {
	const { counts, state } = input
	const now = input.now.getTime()
	const retryRatePercent = d1ReplicaReadRetryRatePercent(counts)
	const triggers: Array<D1ReplicaReadAlertTrigger> = []
	if (
		counts.replicaReads >= d1ReplicaReadAlertMinReplicaReads &&
		retryRatePercent > d1ReplicaReadAlertRetryRatePercent
	) {
		triggers.push('retry_rate')
	}
	if (counts.retries >= d1ReplicaReadAlertRetryBurst) {
		triggers.push('retry_burst')
	}
	if (counts.document500s >= d1ReplicaReadAlertDocument500s) {
		triggers.push('document_500s')
	}
	if (triggers.length === 0)
		return { action: 'below_threshold', retryRatePercent }

	const ongoing =
		state !== null &&
		now - state.lastBreachAt <= d1ReplicaReadAlertIncidentGapMinutes * 60_000
	const incidentKey = ongoing
		? state.incidentKey
		: d1ReplicaReadAlertIncidentKey(input.now)
	if (
		ongoing &&
		now - state.notifiedAt < d1ReplicaReadAlertCooldownMinutes * 60_000
	) {
		return {
			action: 'cooldown',
			retryRatePercent,
			triggers,
			incidentKey,
			nextState: { ...state, lastBreachAt: now },
		}
	}
	return {
		action: 'notify',
		retryRatePercent,
		triggers,
		incidentKey,
		nextState: { incidentKey, notifiedAt: now, lastBreachAt: now },
	}
}

export type D1ReplicaReadAlertEvent = {
	event: typeof d1ReplicaReadAlertTopic
	incident_key: string
	window_minutes: number
	window_start: string
	window_end: string
	replica_reads: number
	retries: number
	write_retries: number
	read_failures: number
	retry_rate_percent: number
	failed_responses: number
	document_500s: number
	colos: Array<{ colo: string; retries: number; failed_responses: number }>
	triggers: Array<D1ReplicaReadAlertTrigger>
	thresholds: {
		retry_rate_percent: number
		min_replica_reads: number
		retry_burst: number
		document_500s: number
	}
	kill_switch: string
	card: {
		projectId: 'kody'
		repoRef: 'kody-hq/kody'
		title: string
		body: string
		labels: Array<string>
		priority: 1
		idempotencyKey: string
	}
	observed_at: string
}

export function buildD1ReplicaReadAlertEvent(input: {
	counts: D1ReplicaReadCounts
	colos: Array<D1ReplicaReadColo>
	retryRatePercent: number
	triggers: Array<D1ReplicaReadAlertTrigger>
	incidentKey: string
	windowStart: Date
	windowEnd: Date
}): D1ReplicaReadAlertEvent {
	const { counts } = input
	const windowMinutes = Math.round(
		(input.windowEnd.getTime() - input.windowStart.getTime()) / 60_000,
	)
	const colos = input.colos.map((row) => ({
		colo: row.colo,
		retries: row.retries,
		failed_responses: row.failedResponses,
	}))
	const window = `${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()}`
	const body = [
		`D1 replica alert: ${counts.retries} of ${counts.replicaReads} replica reads retried on the primary (${input.retryRatePercent}%) in the ${windowMinutes} minutes from ${window}.`,
		'',
		`Triggers: ${input.triggers.join(', ')}.`,
		`Retries: ${counts.writeRetries} after a write, ${counts.readFailures} after a failed replica read.`,
		`Replica reads answered 5xx: ${counts.failedResponses}. Document route 500s on replica reads: ${counts.document500s}.`,
		`Colos: ${colos.length > 0 ? colos.map((row) => `${row.colo} (${row.retries} retries, ${row.failed_responses} 5xx)`).join(', ') : 'unknown'}.`,
		`Thresholds: retry rate over ${d1ReplicaReadAlertRetryRatePercent}% with at least ${d1ReplicaReadAlertMinReplicaReads} replica reads, ${d1ReplicaReadAlertRetryBurst} retries, or ${d1ReplicaReadAlertDocument500s} document route 500s.`,
		'',
		`Kill switch: ${d1ReplicaReadAlertKillSwitch}`,
	].join('\n')
	return {
		event: d1ReplicaReadAlertTopic,
		incident_key: input.incidentKey,
		window_minutes: windowMinutes,
		window_start: input.windowStart.toISOString(),
		window_end: input.windowEnd.toISOString(),
		replica_reads: counts.replicaReads,
		retries: counts.retries,
		write_retries: counts.writeRetries,
		read_failures: counts.readFailures,
		retry_rate_percent: input.retryRatePercent,
		failed_responses: counts.failedResponses,
		document_500s: counts.document500s,
		colos,
		triggers: input.triggers,
		thresholds: {
			retry_rate_percent: d1ReplicaReadAlertRetryRatePercent,
			min_replica_reads: d1ReplicaReadAlertMinReplicaReads,
			retry_burst: d1ReplicaReadAlertRetryBurst,
			document_500s: d1ReplicaReadAlertDocument500s,
		},
		kill_switch: d1ReplicaReadAlertKillSwitch,
		card: {
			projectId: 'kody',
			repoRef: 'kody-hq/kody',
			title: `D1 replica alert: ${input.retryRatePercent}% of replica reads retried (${counts.retries}/${counts.replicaReads})`,
			body,
			labels: ['area:platform', 'observability', 'agent-ready', 'P1'],
			priority: 1,
			idempotencyKey: input.incidentKey,
		},
		observed_at: input.windowEnd.toISOString(),
	}
}

type D1ReplicaReadAlertEnv = Pick<
	Env,
	'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
> & {
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
	D1_REPLICA_READ_EVENTS?: AnalyticsEngineDataset
}

export type D1ReplicaReadAlertResult =
	| {
			status: 'skipped'
			reason: 'missing-analytics-config' | 'query_failed' | 'notify_failed'
	  }
	| ({
			status: 'below_threshold' | 'cooldown' | 'notified'
			retryRatePercent: number
	  } & D1ReplicaReadCounts)

function parseState(raw: string | null): D1ReplicaReadAlertState | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as Partial<D1ReplicaReadAlertState>
		return typeof value.incidentKey === 'string' &&
			typeof value.notifiedAt === 'number' &&
			typeof value.lastBreachAt === 'number'
			? (value as D1ReplicaReadAlertState)
			: null
	} catch {
		console.warn(
			'd1-replica-read-alert-state-unreadable: incident key and cooldown start over',
		)
		return null
	}
}

/**
 * Every 5 minutes: count replica reads, retries, and failures over the last
 * 15 minutes and fan `d1.replica_reads.alert` to admin packages when a
 * threshold trips. The event carries the factory card to file; a sustained
 * spike keeps one incident key and re-sends at most once per cooldown.
 */
export async function checkD1ReplicaReadsAndAlert(input: {
	env: D1ReplicaReadAlertEnv
	now?: Date
}): Promise<D1ReplicaReadAlertResult> {
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!input.env.D1_REPLICA_READ_EVENTS || !accountId || !apiToken) {
		return { status: 'skipped', reason: 'missing-analytics-config' }
	}
	const now = input.now ?? new Date()
	const windowEnd = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
	const windowStart = new Date(
		windowEnd.getTime() - d1ReplicaReadAlertWindowMinutes * 60_000,
	)
	const query = {
		accountId,
		apiToken,
		baseUrl:
			input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com',
	}
	const window = {
		dataset: resolveD1ReplicaReadEventsDataset(input.env),
		windowStart,
		windowEnd,
	}
	let counts: D1ReplicaReadCounts
	try {
		counts = parseD1ReplicaReadTotals(
			await queryAnalyticsEngineSql({
				...query,
				query: buildD1ReplicaReadTotalsQuery(window),
			}),
		)
	} catch (error) {
		console.warn('d1-replica-read-alert-query-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}

	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const decision = decideD1ReplicaReadAlert({
		counts,
		state: parseState(kv ? await kv.get(d1ReplicaReadAlertKvKey) : null),
		now: windowEnd,
	})
	const { retryRatePercent } = decision
	if (decision.action === 'below_threshold') {
		return { status: 'below_threshold', retryRatePercent, ...counts }
	}
	const saveState = async () => {
		await kv?.put(d1ReplicaReadAlertKvKey, JSON.stringify(decision.nextState), {
			expirationTtl: (d1ReplicaReadAlertCooldownMinutes + 60) * 60,
		})
	}
	if (decision.action === 'cooldown') {
		await saveState()
		return { status: 'cooldown', retryRatePercent, ...counts }
	}

	let colos: Array<D1ReplicaReadColo> = []
	try {
		colos = parseD1ReplicaReadColos(
			await queryAnalyticsEngineSql({
				...query,
				query: buildD1ReplicaReadColoQuery(window),
			}),
		)
	} catch (error) {
		console.warn(
			'd1-replica-read-alert-colo-query-failed: the card omits the colo breakdown',
			error,
		)
	}
	const event = buildD1ReplicaReadAlertEvent({
		counts,
		colos,
		retryRatePercent,
		triggers: decision.triggers,
		incidentKey: decision.incidentKey,
		windowStart,
		windowEnd,
	})
	let delivered = false
	try {
		const responses = await dispatchAdminPackageSubscriptionEvent({
			env: input.env,
			baseUrl: getAppBaseUrl({ env: input.env }),
			topic: d1ReplicaReadAlertTopic,
			getParams: () => event as unknown as Record<string, unknown>,
			source: 'd1-replica-read-alert',
			buildIdempotencyKey: (savedPackage) =>
				`d1-replica-alert:${event.incident_key}:${event.observed_at}:${savedPackage.id}`,
			actorTokenId: 'internal:d1-replica-read-alert-subscriptions',
		})
		delivered = responses.some(
			(response) => response && response.status >= 200 && response.status < 400,
		)
	} catch (error) {
		console.warn('d1-replica-read-alert-notification-failed', error)
		return { status: 'skipped', reason: 'notify_failed' }
	}
	if (!delivered) {
		console.warn(
			'd1-replica-read-alert-notification-failed: no subscribed handler accepted the event, cooldown not started',
		)
		return { status: 'skipped', reason: 'notify_failed' }
	}
	await saveState()
	console.warn('d1-replica-read-alerted', {
		window_minutes: event.window_minutes,
		replica_reads: event.replica_reads,
		retries: event.retries,
		retry_rate_percent: event.retry_rate_percent,
		failed_responses: event.failed_responses,
		document_500s: event.document_500s,
		triggers: event.triggers,
	})
	return { status: 'notified', retryRatePercent, ...counts }
}
