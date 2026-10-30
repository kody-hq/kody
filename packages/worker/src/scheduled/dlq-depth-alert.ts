import * as Sentry from '@sentry/cloudflare'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import {
	CloudflareApiError,
	createCloudflareRestClient,
} from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { deadLetterQueueNames } from '#worker/dead-letter/queues.ts'
import {
	summarizeParkedDeadLetterMessages,
	type ParkedDeadLetterSummary,
} from '#worker/dead-letter/store.ts'

/**
 * Pages when a production dead-letter queue still holds work after 15 minutes.
 *
 * Cloudflare queue metrics supply `backlog_count` and the oldest unacknowledged
 * message. A missing oldest timestamp (the API returns 0) falls back to the
 * first tick that observed a non-zero backlog. The cron runs this lane directly
 * so a stuck `kody-scheduled-dispatch` consumer cannot hide its own DLQ.
 *
 * The DLQ consumer parks messages in APP_DB (`dead_letter_messages`) and acks
 * them, so parked rows count toward depth too: a message stays on this page
 * until an admin replays, acks, or purges it
 * (docs/contributing/dead-letter-queues.md).
 *
 * Inbound email subscription dead-letters stay off this page. Those are
 * terminal handler failures on an owner mailbox, not a platform DLQ.
 *
 * Sentry is the operator page. Discord receives the issue from the existing
 * Sentry alert destination, the same path as the webhook auth regression alert.
 */
export const dlqDepthSustainedMs = 15 * 60 * 1000
export const dlqDepthAlertCooldownMinutes = 6 * 60
export const dlqDepthAlertKvKeyPrefix = 'ops-alert:dlq-depth:v1:'
const dlqDepthStateTtlSeconds = 7 * 24 * 60 * 60
const queueListPageLimit = 20

export const productionDeadLetterQueueNames = deadLetterQueueNames

export type DlqDepthVerdict =
	| { kind: 'healthy' }
	| { kind: 'pending'; sinceMs: number; ageMs: number }
	| { kind: 'sustained'; sinceMs: number; ageMs: number }

export function classifyDlqDepth(input: {
	backlogCount: number
	oldestMessageTimestampMs: number | null
	now: Date
	sinceMs: number | null
	sustainedMs?: number
}): DlqDepthVerdict {
	if (input.backlogCount <= 0) return { kind: 'healthy' }
	const sustainedMs = input.sustainedMs ?? dlqDepthSustainedMs
	const nowMs = input.now.getTime()
	const oldest = input.oldestMessageTimestampMs
	const sinceMs =
		oldest != null && oldest > 0 && oldest <= nowMs
			? oldest
			: (input.sinceMs ?? nowMs)
	const ageMs = nowMs - sinceMs
	if (ageMs > sustainedMs) return { kind: 'sustained', sinceMs, ageMs }
	return { kind: 'pending', sinceMs, ageMs }
}

type DlqDepthAlertEnv = {
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_MOCK?: Fetcher
	BUNDLE_ARTIFACTS_KV?: KVNamespace
	APP_DB?: D1Database
}

export type QueueMetrics = {
	backlogCount: number
	backlogBytes: number
	oldestMessageTimestampMs: number | null
}

type DlqDepthMetrics = QueueMetrics & {
	parkedCount: number
	parkedOldestEnqueuedAtMs: number | null
}

function withParked(
	metrics: QueueMetrics,
	parked: ParkedDeadLetterSummary | undefined,
): DlqDepthMetrics {
	const parkedCount = parked?.count ?? 0
	const parkedOldest =
		parkedCount > 0 ? (parked?.oldestEnqueuedAtMs ?? null) : null
	const oldestCandidates = [
		metrics.oldestMessageTimestampMs,
		parkedOldest,
	].filter((value): value is number => value != null)
	return {
		backlogCount: metrics.backlogCount + parkedCount,
		backlogBytes: metrics.backlogBytes,
		oldestMessageTimestampMs:
			oldestCandidates.length > 0 ? Math.min(...oldestCandidates) : null,
		parkedCount,
		parkedOldestEnqueuedAtMs: parkedOldest,
	}
}

type DlqDepthState = {
	sinceMs?: number
	alertedMs?: number
}

export type DlqDepthAlertResult =
	| { status: 'skipped'; reason: 'non_production' }
	| {
			status: 'checked'
			queues: number
			healthy: number
			pending: number
			sustained: number
			alerted: number
			cooldown: number
	  }

export async function checkDlqDepthAndAlert(input: {
	env: DlqDepthAlertEnv
	now?: Date
	sustainedMs?: number
	cooldownMinutes?: number
}): Promise<DlqDepthAlertResult> {
	if (isNonProductionRuntime(input.env)) {
		return { status: 'skipped', reason: 'non_production' }
	}
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!accountId || !apiToken || !kv) {
		throw new Error(
			'DLQ depth alert requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and BUNDLE_ARTIFACTS_KV.',
		)
	}

	const now = input.now ?? new Date()
	const sustainedMs = input.sustainedMs ?? dlqDepthSustainedMs
	const cooldownMinutes = input.cooldownMinutes ?? dlqDepthAlertCooldownMinutes
	const client = createCloudflareRestClient({
		CLOUDFLARE_API_TOKEN: apiToken,
		CLOUDFLARE_API_BASE_URL: input.env.CLOUDFLARE_API_BASE_URL,
		CLOUDFLARE_API_MOCK: input.env.CLOUDFLARE_API_MOCK,
	})
	const queueIds = await listQueueIds(client, accountId)
	const failures: Array<string> = []
	let parkedSummaries = new Map<string, ParkedDeadLetterSummary>()
	if (input.env.APP_DB) {
		try {
			parkedSummaries = await summarizeParkedDeadLetterMessages(
				input.env.APP_DB,
			)
		} catch (error) {
			failures.push(`parked dead-letter messages (${readFailureDetail(error)})`)
		}
	}
	const counts = {
		queues: productionDeadLetterQueueNames.length,
		healthy: 0,
		pending: 0,
		sustained: 0,
		alerted: 0,
		cooldown: 0,
	}
	const persist = async (
		queueName: string,
		stored: DlqDepthState,
		state: DlqDepthState,
	) => {
		try {
			await writeStateIfChanged(kv, queueName, stored, state)
			return true
		} catch (error) {
			failures.push(`${queueName} (state write failed)`)
			console.debug('dlq-depth-alert-state-write-failed', { queueName, error })
			return false
		}
	}

	await Promise.all(
		productionDeadLetterQueueNames.map(async (queueName) => {
			const queueId = queueIds.get(queueName)
			if (!queueId) {
				failures.push(`${queueName} (not found)`)
				return
			}
			let metrics: DlqDepthMetrics
			try {
				metrics = withParked(
					await readQueueMetrics(client, accountId, queueId),
					parkedSummaries.get(queueName),
				)
			} catch (error) {
				failures.push(`${queueName} (${readFailureDetail(error)})`)
				return
			}
			const read = await readState(kv, queueName)
			if (read.failed) {
				failures.push(`${queueName} (state read failed)`)
				return
			}
			const stored = read.state
			const verdict = classifyDlqDepth({
				backlogCount: metrics.backlogCount,
				oldestMessageTimestampMs: metrics.oldestMessageTimestampMs,
				now,
				sinceMs: stored.sinceMs ?? null,
				sustainedMs,
			})
			if (verdict.kind === 'healthy') {
				counts.healthy += 1
				await persist(queueName, stored, {})
				return
			}
			// Keep the start of this nonempty episode even when a later sample
			// includes an oldest-message timestamp. A following sample that
			// reports 0 (unknown) must not restart the 15 minute clock.
			const episodeSinceMs =
				stored.sinceMs == null
					? verdict.sinceMs
					: Math.min(stored.sinceMs, verdict.sinceMs)
			const next: DlqDepthState = {
				sinceMs: episodeSinceMs,
				...(stored.alertedMs != null ? { alertedMs: stored.alertedMs } : {}),
			}
			if (verdict.kind === 'pending') {
				counts.pending += 1
				await persist(queueName, stored, next)
				return
			}
			counts.sustained += 1
			if (isOnCooldown(stored.alertedMs, now, cooldownMinutes)) {
				counts.cooldown += 1
				await persist(queueName, stored, next)
				return
			}
			// Store the cooldown before paging. A failed write must not leave a
			// page that the next tick will send again.
			const recorded = await persist(queueName, stored, {
				...next,
				alertedMs: now.getTime(),
			})
			if (!recorded) return
			reportDlqDepth({
				queueName,
				queueId,
				metrics,
				verdict,
			})
			counts.alerted += 1
		}),
	)

	if (failures.length > 0) {
		throw new Error(`DLQ depth alert failed for ${failures.sort().join(', ')}.`)
	}
	return { status: 'checked', ...counts }
}

function reportDlqDepth(input: {
	queueName: string
	queueId: string
	metrics: DlqDepthMetrics
	verdict: Extract<DlqDepthVerdict, { kind: 'sustained' }>
}) {
	const minutes = Math.floor(input.verdict.ageMs / 60_000)
	const parkedNote =
		input.metrics.parkedCount > 0
			? ` (${String(input.metrics.parkedCount)} parked for admin replay, ack, or purge)`
			: ''
	const message = `Dead-letter queue ${input.queueName} still has ${unacknowledgedLabel(input.metrics.backlogCount)}${parkedNote} after ${String(minutes)} minutes.`
	console.warn('dlq-depth-alerted', {
		queueName: input.queueName,
		backlogCount: input.metrics.backlogCount,
		ageMs: input.verdict.ageMs,
	})
	Sentry.withScope((scope) => {
		scope.setLevel('warning')
		scope.setFingerprint(['dlq-depth', input.queueName])
		scope.setTag('queue.dlq_depth', 'true')
		scope.setTag('queue.name', input.queueName)
		scope.setTag('scheduled.lane', 'dlq_depth_alert')
		scope.setContext('dlq_depth', {
			queueName: input.queueName,
			queueId: input.queueId,
			backlogCount: input.metrics.backlogCount,
			backlogBytes: input.metrics.backlogBytes,
			parkedCount: input.metrics.parkedCount,
			parkedOldestEnqueuedAtMs: input.metrics.parkedOldestEnqueuedAtMs,
			oldestMessageTimestampMs: input.metrics.oldestMessageTimestampMs,
			ageMs: input.verdict.ageMs,
		})
		Sentry.captureMessage(message)
	})
}

function unacknowledgedLabel(count: number) {
	return count === 1
		? '1 unacknowledged message'
		: `${String(count)} unacknowledged messages`
}

function isOnCooldown(
	alertedMs: number | undefined,
	now: Date,
	cooldownMinutes: number,
) {
	return (
		alertedMs != null && now.getTime() - alertedMs < cooldownMinutes * 60_000
	)
}

export type CloudflareQueueClient = {
	rawRequest: (input: {
		method: 'GET'
		path: string
		query?: Record<string, string>
	}) => Promise<{ status: number; body: unknown | null }>
}

export async function listQueueIds(
	client: CloudflareQueueClient,
	accountId: string,
) {
	const ids = new Map<string, string>()
	let page = 1
	let totalPages = 1
	do {
		if (page > queueListPageLimit) {
			throw new Error(
				`Cloudflare queue list exceeded ${String(queueListPageLimit)} pages.`,
			)
		}
		const response = await client.rawRequest({
			method: 'GET',
			path: `/client/v4/accounts/${encodeURIComponent(accountId)}/queues`,
			query: { page: String(page), per_page: '100' },
		})
		const queues = readCloudflareResult<
			Array<{ queue_id?: string; queue_name?: string }>
		>(response.body)
		if (response.status >= 400 || !queues) {
			throw new CloudflareApiError(
				`Failed to list Cloudflare Queues (${String(response.status)}).`,
				{ status: response.status },
			)
		}
		for (const queue of queues) {
			if (queue.queue_id && queue.queue_name) {
				ids.set(queue.queue_name, queue.queue_id)
			}
		}
		totalPages = readTotalPages(response.body)
		page += 1
	} while (page <= totalPages)
	return ids
}

export async function readQueueMetrics(
	client: CloudflareQueueClient,
	accountId: string,
	queueId: string,
): Promise<QueueMetrics> {
	const response = await client.rawRequest({
		method: 'GET',
		path: `/client/v4/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}/metrics`,
	})
	const result = readCloudflareResult<Record<string, unknown>>(response.body)
	if (response.status >= 400 || !result) {
		const detail = readErrorMessage(response.body)
		throw new CloudflareApiError(
			detail
				? `Failed to read Cloudflare Queue metrics (${String(response.status)}): ${detail}`
				: `Failed to read Cloudflare Queue metrics (${String(response.status)}).`,
			{ status: response.status },
		)
	}
	const backlogCount = result['backlog_count']
	if (typeof backlogCount !== 'number' || !Number.isFinite(backlogCount)) {
		throw new Error('Queue metrics omitted backlog_count.')
	}
	const backlogBytes = result['backlog_bytes']
	const oldest = result['oldest_message_timestamp_ms']
	return {
		backlogCount,
		backlogBytes:
			typeof backlogBytes === 'number' && Number.isFinite(backlogBytes)
				? backlogBytes
				: 0,
		oldestMessageTimestampMs:
			typeof oldest === 'number' && Number.isFinite(oldest) && oldest > 0
				? oldest
				: null,
	}
}

function readFailureDetail(error: unknown) {
	if (error instanceof CloudflareApiError) {
		return error.message
	}
	if (error instanceof Error) return error.message
	return 'unknown error'
}

function kvKey(queueName: string) {
	return `${dlqDepthAlertKvKeyPrefix}${queueName}`
}

async function readState(
	kv: KVNamespace,
	queueName: string,
): Promise<{ state: DlqDepthState; failed: boolean }> {
	try {
		return { state: parseState(await kv.get(kvKey(queueName))), failed: false }
	} catch (error) {
		console.debug('dlq-depth-alert-state-read-failed', { queueName, error })
		return { state: {}, failed: true }
	}
}

async function writeStateIfChanged(
	kv: KVNamespace,
	queueName: string,
	stored: DlqDepthState,
	state: DlqDepthState,
) {
	if (serializeState(stored) === serializeState(state)) return
	const key = kvKey(queueName)
	const next = serializeState(state)
	if (!next) {
		await kv.delete(key)
		return
	}
	await kv.put(key, next, { expirationTtl: dlqDepthStateTtlSeconds })
}

function serializeState(state: DlqDepthState) {
	const body: DlqDepthState = {}
	if (state.sinceMs != null) body.sinceMs = state.sinceMs
	if (state.alertedMs != null) body.alertedMs = state.alertedMs
	if (body.sinceMs == null && body.alertedMs == null) return null
	return JSON.stringify(body)
}

function parseState(raw: string | null): DlqDepthState {
	if (!raw) return {}
	try {
		const value = JSON.parse(raw) as unknown
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
		const record = value as Record<string, unknown>
		const sinceMs = record['sinceMs']
		const alertedMs = record['alertedMs']
		return {
			...(typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs > 0
				? { sinceMs }
				: {}),
			...(typeof alertedMs === 'number' &&
			Number.isFinite(alertedMs) &&
			alertedMs > 0
				? { alertedMs }
				: {}),
		}
	} catch {
		return {}
	}
}

function readCloudflareResult<T>(body: unknown): T | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	if (record['success'] !== true) return null
	return (record['result'] as T | undefined) ?? null
}

function readTotalPages(body: unknown) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return 1
	const info = (body as Record<string, unknown>)['result_info']
	if (!info || typeof info !== 'object' || Array.isArray(info)) return 1
	const total = Number((info as Record<string, unknown>)['total_pages'] ?? 1)
	return Number.isFinite(total) ? Math.max(1, total) : 1
}

function readErrorMessage(body: unknown) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
	const errors = (body as Record<string, unknown>)['errors']
	if (!Array.isArray(errors)) return ''
	const message = errors
		.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
			const text = (entry as Record<string, unknown>)['message']
			return typeof text === 'string' ? text : ''
		})
		.filter((text) => text.length > 0)
		.join('; ')
	return message.slice(0, 200)
}
