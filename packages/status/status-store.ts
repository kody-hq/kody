import { DurableObject } from 'cloudflare:workers'
import { sendAlertEmail } from './alert-email.ts'
import { incidentMinutesForDay, type IncidentSpan } from './day-bars.ts'
import {
	dailyFailedAfterIncidentDelete,
	dailyFailedIncrement,
	daysFromFirstSample,
	daysToClearNonIncidentFailures,
	nonIncidentFailuresRetiredMetaKey,
	utcDaysInSpan,
} from './incident-rollups.ts'
import {
	composeStatusEmail,
	decideStatusEmail,
	defaultDailyEmailLimit,
	type OpenIncidentSummary,
} from './email-policy.ts'
import {
	composeGrokBotWakePrompt,
	decideGrokBotWake,
	defaultGrokBotWakeDailyLimit,
	sendGrokBotWake,
	type WakeIncident,
} from './grok-bot-wake.ts'
import {
	applyProbeResult,
	initialComponentProbeState,
	type ComponentProbeState,
} from './incidents.ts'
import {
	buildStatusIncidentOpenedPayload,
	buildStatusIncidentResolvedPayload,
	notifyStatusIncidentEvent,
	type StatusIncidentEventPayload,
} from './incident-events.ts'
import {
	addIncidentRetrospectiveColumnSql,
	incidentRowToView,
	incidentsTableHasRetrospectiveColumn,
	selectIncidentByIdSql,
	serializeIncidentRetrospective,
	updateIncidentRetrospectiveSql,
	type IncidentRetrospective,
	type IncidentRow,
} from './retrospective.ts'
import {
	publicAuditDbRetiredMetaKey,
	retirePublicAuditDbData,
} from './retire-public-audit-db.ts'
import {
	applyExecuteHealthTick,
	deriveExecuteHealthView,
	mergeExecuteLastSuccess,
	readExecuteHealthSyntheticResult,
	resolvePublicExecuteLastSuccess,
	type ExecuteHealthCoordinatorState,
} from './execute-health.ts'
import {
	fetchExecuteEvidenceLastSuccessAt,
	jobsProbeOrigin,
	runAllProbes,
} from './probes.ts'
import {
	fetchRelevantProviderIncidents,
	parseProviderIncidentCache,
	serializeProviderIncidentCache,
	type ProviderIncident,
} from './provider-incidents.ts'
import {
	isStatusComponentId,
	statusComponents,
	type ComponentDayStat,
	type ComponentSnapshot,
	type ComponentStatus,
	type IncidentView,
	type ProbeOutcome,
	type StatusComponentId,
	type StatusSnapshot,
} from './status-types.ts'

const providerIncidentsMetaKey = 'provider_incidents_cache'
const productionCommitMetaKey = 'production_commit_sha'
const runtimeCommitMetaKey = 'runtime_commit_sha'
const jobsCommitMetaKey = 'jobs_commit_sha'
const executeLastSuccessMetaKey = 'execute_health_last_success_at'
const executeLastSyntheticAttemptMetaKey =
	'execute_health_last_synthetic_attempt_at'
const executeLastSyntheticSuccessMetaKey =
	'execute_health_last_synthetic_success_at'
const executeLastSyntheticErrorMetaKey = 'execute_health_last_synthetic_error'

export type StatusWorkerEnv = {
	STATUS_STORE: DurableObjectNamespace<StatusStore>
	JOBS?: Fetcher
	/** Non-public fallback origin for jobs probes when JOBS is unset. */
	JOBS_ORIGIN?: string
	PRIMARY_ORIGIN: string
	PACKAGE_APP_ORIGIN: string
	STATUS_PAGE_URL: string
	ALERT_EMAIL_TO: string
	ALERT_EMAIL_FROM: string
	STATUS_ALERT_DAILY_LIMIT?: string
	BUILD_COMMIT?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	/** Worker secret: Cloudflare API token with Email Sending permission. */
	CLOUDFLARE_API_TOKEN?: string
	/**
	 * Shared bearer with the main worker `STATUS_INCIDENT_EVENT_SECRET`.
	 * When unset, incident emit is skipped and sweep polling remains the
	 * ingest backstop.
	 */
	STATUS_INCIDENT_EVENT_SECRET?: string
	/** Worker secret: Grok Bot wake webhook URL (full HTTPS URL). */
	STATUS_GROK_BOT_WAKE_URL?: string
	/** Worker secret: bearer sent as `Authorization` on the wake POST. */
	STATUS_GROK_BOT_WAKE_TOKEN?: string
	STATUS_GROK_BOT_ID?: string
	STATUS_GROK_BOT_NAME?: string
	STATUS_GROK_BOT_WAKE_DAILY_LIMIT?: string
}

const sampleRetentionMs = 25 * 60 * 60 * 1000
const dailyStatRetentionDays = 92
const incidentRetentionMs = 90 * 24 * 60 * 60 * 1000
const uptimeWindowDays = 90
const recentIncidentLimit = 20

function toDay(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10)
}

export class StatusStore extends DurableObject<StatusWorkerEnv> {
	constructor(ctx: DurableObjectState, env: StatusWorkerEnv) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
		})
	}

	private initializeSchema() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS samples (
				component TEXT NOT NULL,
				checked_at INTEGER NOT NULL,
				ok INTEGER NOT NULL,
				latency_ms INTEGER,
				detail TEXT
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_samples_component_time
			ON samples(component, checked_at DESC)`,
		)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS daily_stats (
				component TEXT NOT NULL,
				day TEXT NOT NULL,
				total INTEGER NOT NULL,
				failed INTEGER NOT NULL,
				PRIMARY KEY (component, day)
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS component_state (
				component TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				consecutive_failures INTEGER NOT NULL,
				consecutive_successes INTEGER NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS incidents (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				component TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				resolved_at INTEGER,
				detail TEXT,
				retrospective TEXT
			)
		`)
		this.ensureIncidentRetrospectiveColumn()
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS notifications (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				day TEXT NOT NULL,
				subject TEXT NOT NULL,
				delivered INTEGER NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS bot_wakes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				day TEXT NOT NULL,
				incident_ids TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS bot_wake_incidents (
				incident_id INTEGER PRIMARY KEY,
				opened_wake_at INTEGER NOT NULL,
				all_clear_wake_at INTEGER
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`)
		this.maybeRetirePublicAuditDb()
		this.maybeClearNonIncidentFailures()
	}

	private ensureIncidentRetrospectiveColumn() {
		const columns = this.ctx.storage.sql
			.exec<{ name: string }>(`PRAGMA table_info(incidents)`)
			.toArray()
		if (incidentsTableHasRetrospectiveColumn(columns)) return
		this.ctx.storage.sql.exec(addIncidentRetrospectiveColumnSql)
	}

	private maybeRetirePublicAuditDb() {
		if (this.getMeta(publicAuditDbRetiredMetaKey) === '1') return
		retirePublicAuditDbData((query, ...bindings) => {
			this.ctx.storage.sql.exec(query, ...bindings)
		})
		this.setMeta(publicAuditDbRetiredMetaKey, '1')
		if (this.listOpenIncidents().length === 0) {
			this.setMeta('last_notified_state', 'ok')
		}
	}

	private maybeClearNonIncidentFailures() {
		if (this.getMeta(nonIncidentFailuresRetiredMetaKey) === '1') return
		const now = Date.now()
		const stats = this.ctx.storage.sql
			.exec<{ component: string; day: string; failed: number }>(
				`SELECT component, day, failed FROM daily_stats WHERE failed > 0`,
			)
			.toArray()
		const spansByComponent = this.loadIncidentSpans(0, now)
		for (const row of daysToClearNonIncidentFailures(
			stats,
			spansByComponent,
			now,
		)) {
			this.ctx.storage.sql.exec(
				`UPDATE daily_stats SET failed = 0 WHERE component = ? AND day = ?`,
				row.component,
				row.day,
			)
		}
		this.setMeta(nonIncidentFailuresRetiredMetaKey, '1')
	}

	private getMeta(key: string): string | null {
		const rows = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
			.toArray()
		return rows[0]?.value ?? null
	}

	private setMeta(key: string, value: string) {
		this.ctx.storage.sql.exec(
			`INSERT INTO meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		)
	}

	private deleteMeta(key: string) {
		this.ctx.storage.sql.exec(`DELETE FROM meta WHERE key = ?`, key)
	}

	private readEpochMeta(key: string): number | null {
		const raw = this.getMeta(key)
		if (!raw) return null
		const value = Number(raw)
		return Number.isFinite(value) ? value : null
	}

	private readExecuteHealthState(
		lastSuccessAt: number | null,
	): ExecuteHealthCoordinatorState {
		const storedSuccessAt = this.readEpochMeta(executeLastSuccessMetaKey)
		return {
			lastSuccessAt: mergeExecuteLastSuccess(lastSuccessAt, storedSuccessAt),
			lastSyntheticAttemptAt: this.readEpochMeta(
				executeLastSyntheticAttemptMetaKey,
			),
			lastSyntheticSuccessAt: this.readEpochMeta(
				executeLastSyntheticSuccessMetaKey,
			),
			lastSyntheticError: this.getMeta(executeLastSyntheticErrorMetaKey),
			syntheticConfigured: Boolean(
				this.env.STATUS_INCIDENT_EVENT_SECRET?.trim(),
			),
		}
	}

	private writeExecuteHealthState(state: ExecuteHealthCoordinatorState) {
		// getSnapshot can persist newer organic last-success while the
		// synthetic fetch has the input gate open. Never rewind that write.
		const lastSuccessAt = mergeExecuteLastSuccess(
			state.lastSuccessAt,
			this.readEpochMeta(executeLastSuccessMetaKey),
		)
		if (lastSuccessAt !== null) {
			this.setMeta(executeLastSuccessMetaKey, String(lastSuccessAt))
		}
		if (state.lastSyntheticAttemptAt !== null) {
			this.setMeta(
				executeLastSyntheticAttemptMetaKey,
				String(state.lastSyntheticAttemptAt),
			)
		}
		if (state.lastSyntheticSuccessAt !== null) {
			this.setMeta(
				executeLastSyntheticSuccessMetaKey,
				String(state.lastSyntheticSuccessAt),
			)
		}
		if (state.lastSyntheticError) {
			this.setMeta(executeLastSyntheticErrorMetaKey, state.lastSyntheticError)
		} else {
			this.deleteMeta(executeLastSyntheticErrorMetaKey)
		}
	}

	private async runExecuteHealthSynthetic(): Promise<{
		ok: boolean
		error?: string | null
	}> {
		const secret = this.env.STATUS_INCIDENT_EVENT_SECRET?.trim()
		if (!secret) {
			return { ok: false, error: 'not-configured' }
		}
		const response = await fetch(
			`${this.env.PRIMARY_ORIGIN}/__maintenance/mcp-execute-health`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${secret}`,
					'User-Agent': 'kody-status-prober',
				},
				redirect: 'manual',
				signal: AbortSignal.timeout(15_000),
			},
		)
		let body: { ok?: unknown; reason?: unknown; error?: unknown } | null = null
		try {
			body = (await response.json()) as {
				ok?: unknown
				reason?: unknown
				error?: unknown
			}
		} catch {
			body = null
		}
		const result = readExecuteHealthSyntheticResult({
			status: response.status,
			body,
		})
		if (!result.ok) {
			console.warn(
				'execute-health-synthetic-failed',
				result.error ?? `HTTP ${String(response.status)}`,
			)
		}
		return result
	}

	private loadComponentState(
		component: StatusComponentId,
	): ComponentProbeState {
		const rows = this.ctx.storage.sql
			.exec<{
				status: string
				consecutive_failures: number
				consecutive_successes: number
			}>(
				`SELECT status, consecutive_failures, consecutive_successes
				FROM component_state WHERE component = ?`,
				component,
			)
			.toArray()
		const row = rows[0]
		if (!row) return initialComponentProbeState
		return {
			status: row.status === 'down' ? 'down' : 'operational',
			consecutiveFailures: row.consecutive_failures,
			consecutiveSuccesses: row.consecutive_successes,
		}
	}

	private saveComponentState(
		component: StatusComponentId,
		state: ComponentProbeState,
	) {
		this.ctx.storage.sql.exec(
			`INSERT INTO component_state
			(component, status, consecutive_failures, consecutive_successes)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(component) DO UPDATE SET
				status = excluded.status,
				consecutive_failures = excluded.consecutive_failures,
				consecutive_successes = excluded.consecutive_successes`,
			component,
			state.status,
			state.consecutiveFailures,
			state.consecutiveSuccesses,
		)
	}

	private recordOutcome(outcome: ProbeOutcome, now: number) {
		if (outcome.skip) return
		this.ctx.storage.sql.exec(
			`INSERT INTO samples (component, checked_at, ok, latency_ms, detail)
			VALUES (?, ?, ?, ?, ?)`,
			outcome.component,
			now,
			outcome.ok ? 1 : 0,
			outcome.latencyMs,
			outcome.detail,
		)
		const previous = this.loadComponentState(outcome.component)
		const { state, transition } = applyProbeResult(previous, outcome.ok)
		this.saveComponentState(outcome.component, state)
		this.ctx.storage.sql.exec(
			`INSERT INTO daily_stats (component, day, total, failed)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(component, day) DO UPDATE SET
				total = total + 1,
				failed = failed + excluded.failed`,
			outcome.component,
			toDay(now),
			dailyFailedIncrement(outcome.ok, state.status),
		)
		if (transition === 'opened') {
			this.ctx.storage.sql.exec(
				`INSERT INTO incidents (component, started_at, resolved_at, detail)
				VALUES (?, ?, NULL, ?)`,
				outcome.component,
				now,
				outcome.detail,
			)
			console.warn(
				'status-incident-opened',
				JSON.stringify({
					component: outcome.component,
					detail: outcome.detail,
				}),
			)
			this.enqueueIncidentEvent(
				buildStatusIncidentOpenedPayload({
					component: outcome.component,
					detail: outcome.detail,
					startedAt: now,
					statusUrl: this.env.STATUS_PAGE_URL,
				}),
			)
		}
		if (transition === 'resolved') {
			const open = this.loadOpenIncident(outcome.component)
			this.ctx.storage.sql.exec(
				`UPDATE incidents SET resolved_at = ?
				WHERE component = ? AND resolved_at IS NULL`,
				now,
				outcome.component,
			)
			console.info(
				'status-incident-resolved',
				JSON.stringify({ component: outcome.component }),
			)
			if (open) {
				this.enqueueIncidentEvent(
					buildStatusIncidentResolvedPayload({
						component: outcome.component,
						detail: open.detail,
						startedAt: open.startedAt,
						resolvedAt: now,
						statusUrl: this.env.STATUS_PAGE_URL,
					}),
				)
			}
		}
	}

	private loadOpenIncident(component: StatusComponentId) {
		const row = this.ctx.storage.sql
			.exec<{ started_at: number; detail: string | null }>(
				`SELECT started_at, detail FROM incidents
				WHERE component = ? AND resolved_at IS NULL`,
				component,
			)
			.toArray()[0]
		if (!row) return null
		return { startedAt: row.started_at, detail: row.detail }
	}

	private enqueueIncidentEvent(payload: StatusIncidentEventPayload) {
		this.ctx.waitUntil(
			notifyStatusIncidentEvent({
				primaryOrigin: this.env.PRIMARY_ORIGIN,
				secret: this.env.STATUS_INCIDENT_EVENT_SECRET,
				payload,
			}).then((result) => {
				if (!result.ok) {
					console.warn(
						'status-incident-event-failed',
						JSON.stringify({
							event: payload.event,
							component: payload.incident.component,
							error: result.error,
						}),
					)
				}
			}),
		)
	}

	private listOpenIncidents(): Array<OpenIncidentSummary> {
		// Rows for retired component ids stay in SQLite; they must not page.
		return this.ctx.storage.sql
			.exec<{ component: string; started_at: number; detail: string | null }>(
				`SELECT component, started_at, detail FROM incidents
				WHERE resolved_at IS NULL ORDER BY started_at ASC`,
			)
			.toArray()
			.flatMap((row) => {
				if (!isStatusComponentId(row.component)) return []
				return [
					{
						component: row.component,
						startedAt: row.started_at,
						detail: row.detail,
					},
				]
			})
	}

	private listOpenWakeIncidents(): Array<WakeIncident> {
		return this.ctx.storage.sql
			.exec<{
				id: number
				component: string
				started_at: number
				detail: string | null
			}>(
				`SELECT id, component, started_at, detail FROM incidents
				WHERE resolved_at IS NULL ORDER BY started_at ASC, id ASC`,
			)
			.toArray()
			.flatMap((row) => {
				if (!isStatusComponentId(row.component)) return []
				return [
					{
						id: row.id,
						component: row.component,
						startedAt: row.started_at,
						detail: row.detail,
					},
				]
			})
	}

	/**
	 * Decides and records at most one Grok Bot wake per probe tick. The record
	 * is written before the POST so a slow or failed webhook never resends for
	 * the same incident ids; the POST itself runs in `waitUntil` so it never
	 * stalls probes or the alert email.
	 */
	private maybeWakeGrokBot(now: number) {
		const openIncidents = this.listOpenWakeIncidents()
		const wokenIncidentIds = new Set(
			this.ctx.storage.sql
				.exec<{ incident_id: number }>(
					`SELECT incident_id FROM bot_wake_incidents`,
				)
				.toArray()
				.map((row) => row.incident_id),
		)
		const pendingAllClear = this.ctx.storage.sql
			.exec<{
				id: number
				component: string
				started_at: number
				resolved_at: number | null
				detail: string | null
			}>(
				`SELECT i.id, i.component, i.started_at, i.resolved_at, i.detail
				FROM bot_wake_incidents w JOIN incidents i ON i.id = w.incident_id
				WHERE w.all_clear_wake_at IS NULL AND i.resolved_at IS NOT NULL
				ORDER BY i.started_at ASC, i.id ASC`,
			)
			.toArray()
			.flatMap((row): Array<WakeIncident> => {
				if (!isStatusComponentId(row.component)) return []
				return [
					{
						id: row.id,
						component: row.component,
						startedAt: row.started_at,
						resolvedAt: row.resolved_at,
						detail: row.detail,
					},
				]
			})
		const day = toDay(now)
		const wakesSentToday =
			this.ctx.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM bot_wakes WHERE day = ?`,
					day,
				)
				.toArray()[0]?.count ?? 0
		const dailyLimitRaw = Number(this.env.STATUS_GROK_BOT_WAKE_DAILY_LIMIT)
		const dailyLimit =
			Number.isInteger(dailyLimitRaw) && dailyLimitRaw > 0
				? dailyLimitRaw
				: defaultGrokBotWakeDailyLimit
		const decision = decideGrokBotWake({
			openIncidents,
			wokenIncidentIds,
			pendingAllClear,
			wakesSentToday,
			dailyLimit,
		})
		if (!decision) {
			if (wakesSentToday >= dailyLimit) {
				const fresh = openIncidents.some(
					(incident) => !wokenIncidentIds.has(incident.id),
				)
				if (fresh) {
					console.warn(
						'status-grok-bot-wake-capped',
						JSON.stringify({ wakesSentToday, dailyLimit }),
					)
				}
			}
			return
		}
		const incidentIds = decision.incidents.map((incident) => incident.id)
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`INSERT INTO bot_wakes (kind, sent_at, day, incident_ids)
				VALUES (?, ?, ?, ?)`,
				decision.kind,
				now,
				day,
				JSON.stringify(incidentIds),
			)
			for (const id of incidentIds) {
				if (decision.kind === 'opened') {
					this.ctx.storage.sql.exec(
						`INSERT OR IGNORE INTO bot_wake_incidents (incident_id, opened_wake_at)
						VALUES (?, ?)`,
						id,
						now,
					)
				} else {
					this.ctx.storage.sql.exec(
						`UPDATE bot_wake_incidents SET all_clear_wake_at = ?
						WHERE incident_id = ?`,
						now,
						id,
					)
				}
			}
		})
		const prompt = composeGrokBotWakePrompt({
			decision,
			openIncidents,
			statusPageUrl: this.env.STATUS_PAGE_URL,
			now,
		})
		this.ctx.waitUntil(
			sendGrokBotWake({
				url: this.env.STATUS_GROK_BOT_WAKE_URL,
				token: this.env.STATUS_GROK_BOT_WAKE_TOKEN,
				botId: this.env.STATUS_GROK_BOT_ID,
				botName: this.env.STATUS_GROK_BOT_NAME,
				prompt,
			}).then((result) => {
				const summary = { kind: decision.kind, incidentIds }
				if (!result.ok) {
					console.warn(
						'status-grok-bot-wake-failed',
						JSON.stringify({ ...summary, error: result.error }),
					)
				} else if (result.skipped) {
					console.warn(
						'status-grok-bot-wake-skipped',
						JSON.stringify({ ...summary, reason: result.reason }),
					)
				} else {
					console.info('status-grok-bot-wake-sent', JSON.stringify(summary))
				}
			}),
		)
	}

	private async maybeSendAlert(now: number) {
		const openIncidents = this.listOpenIncidents()
		const day = toDay(now)
		const emailsSentToday =
			this.ctx.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM notifications WHERE day = ?`,
					day,
				)
				.toArray()[0]?.count ?? 0
		const lastEmailSentAt =
			this.ctx.storage.sql
				.exec<{ latest: number | null }>(
					`SELECT MAX(sent_at) AS latest FROM notifications`,
				)
				.toArray()[0]?.latest ?? null
		const lastNotifiedState =
			this.getMeta('last_notified_state') === 'incident' ? 'incident' : 'ok'
		const dailyLimitRaw = Number(this.env.STATUS_ALERT_DAILY_LIMIT)
		const dailyLimit =
			Number.isInteger(dailyLimitRaw) && dailyLimitRaw > 0
				? dailyLimitRaw
				: defaultDailyEmailLimit
		const decision = decideStatusEmail({
			now,
			openIncidents,
			lastNotifiedState,
			lastEmailSentAt,
			emailsSentToday,
			dailyLimit,
		})
		if (!decision) {
			if (
				emailsSentToday >= dailyLimit &&
				(openIncidents.length > 0 || lastNotifiedState === 'incident')
			) {
				console.warn(
					'status-alert-email-capped',
					JSON.stringify({ emailsSentToday, dailyLimit }),
				)
			}
			return
		}
		const content = composeStatusEmail({
			kind: decision.kind,
			openIncidents,
			statusPageUrl: this.env.STATUS_PAGE_URL,
			now,
			providerIncidents: this.readProviderIncidents(now),
		})
		const result = await sendAlertEmail(
			{
				accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
				apiToken: this.env.CLOUDFLARE_API_TOKEN,
				apiBaseUrl: this.env.CLOUDFLARE_API_BASE_URL,
			},
			{
				from: this.env.ALERT_EMAIL_FROM,
				to: this.env.ALERT_EMAIL_TO,
				subject: content.subject,
				text: content.text,
				html: content.html,
			},
		)
		// Every attempt is recorded so the daily cap bounds API calls even when
		// sends fail permanently (for example an invalid token would otherwise
		// retry every minute forever). `last_notified_state` only advances on a
		// delivered or unconfigured-skip send, so failed attempts retry on the
		// next tick until the cap stops them for the day.
		this.ctx.storage.sql.exec(
			`INSERT INTO notifications (kind, sent_at, day, subject, delivered)
			VALUES (?, ?, ?, ?, ?)`,
			decision.kind,
			now,
			day,
			content.subject,
			result.delivered ? 1 : 0,
		)
		if (!result.delivered && !result.skipped) return
		this.setMeta(
			'last_notified_state',
			openIncidents.length > 0 ? 'incident' : 'ok',
		)
		console.info(
			'status-alert-email-recorded',
			JSON.stringify({
				kind: decision.kind,
				subject: content.subject,
				delivered: result.delivered,
			}),
		)
	}

	private prune(now: number) {
		this.ctx.storage.sql.exec(
			`DELETE FROM samples WHERE checked_at < ?`,
			now - sampleRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM daily_stats WHERE day < ?`,
			toDay(now - dailyStatRetentionDays * 24 * 60 * 60 * 1000),
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?`,
			now - incidentRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM notifications WHERE sent_at < ?`,
			now - incidentRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM bot_wakes WHERE sent_at < ?`,
			now - incidentRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM bot_wake_incidents WHERE opened_wake_at < ?
			AND incident_id NOT IN (SELECT id FROM incidents WHERE resolved_at IS NULL)`,
			now - incidentRetentionMs,
		)
	}

	private readProviderIncidents(now: number): Array<ProviderIncident> | null {
		return parseProviderIncidentCache(
			this.getMeta(providerIncidentsMetaKey),
			now,
		)
	}

	private async refreshProviderIncidents(now: number): Promise<void> {
		const result = await fetchRelevantProviderIncidents()
		if (!result.ok) {
			// Keep any still-fresh cache so a hammered Statuspage API does not
			// blank the section mid-incident. Stale entries age out via
			// parseProviderIncidentCache.
			return
		}
		this.setMeta(
			providerIncidentsMetaKey,
			serializeProviderIncidentCache({
				fetchedAt: now,
				incidents: result.incidents,
			}),
		)
	}

	async runProbes(): Promise<void> {
		const jobsFetcher = this.env.JOBS
			? (this.env.JOBS.fetch.bind(this.env.JOBS) as typeof fetch)
			: undefined
		const {
			outcomes,
			productionCommitSha,
			runtimeCommitSha,
			jobsCommitSha,
			executeLastSuccessAt,
		} = await runAllProbes({
			primaryOrigin: this.env.PRIMARY_ORIGIN,
			packageAppOrigin: this.env.PACKAGE_APP_ORIGIN,
			jobsOrigin: this.env.JOBS_ORIGIN ?? jobsProbeOrigin,
			jobsFetcher,
		})
		const now = Date.now()
		if (productionCommitSha) {
			this.setMeta(productionCommitMetaKey, productionCommitSha)
		}
		if (runtimeCommitSha) {
			this.setMeta(runtimeCommitMetaKey, runtimeCommitSha)
		}
		if (jobsCommitSha) {
			this.setMeta(jobsCommitMetaKey, jobsCommitSha)
		}
		for (const outcome of outcomes) {
			this.recordOutcome(outcome, now)
		}
		this.maybeWakeGrokBot(now)
		const executeState = await applyExecuteHealthTick({
			now,
			...this.readExecuteHealthState(executeLastSuccessAt),
			runSynthetic: async () => {
				try {
					return await this.runExecuteHealthSynthetic()
				} catch (error) {
					return {
						ok: false,
						error:
							error instanceof Error ? error.message.slice(0, 200) : 'error',
					}
				}
			},
		})
		this.writeExecuteHealthState(executeState)
		await this.refreshProviderIncidents(now)
		await this.maybeSendAlert(now)
		this.prune(now)
	}

	async setIncidentRetrospective(
		id: number,
		retrospective: IncidentRetrospective,
	): Promise<
		| { ok: true; incident: IncidentView }
		| { ok: false; error: 'not-found' | 'not-resolved' }
	> {
		const existing = this.loadIncidentById(id)
		if (!existing) return { ok: false, error: 'not-found' }
		if (existing.resolvedAt === null)
			return { ok: false, error: 'not-resolved' }
		this.ctx.storage.sql.exec(
			updateIncidentRetrospectiveSql,
			serializeIncidentRetrospective(retrospective),
			id,
		)
		const updated = this.loadIncidentById(id)
		if (!updated) return { ok: false, error: 'not-found' }
		return { ok: true, incident: updated }
	}

	async deleteIncident(
		id: number,
	): Promise<
		| { ok: true; incident: IncidentView }
		| { ok: false; error: 'not-found' | 'not-resolved' }
	> {
		const row = this.ctx.storage.sql
			.exec<IncidentRow>(selectIncidentByIdSql, id)
			.toArray()[0]
		const incident = row ? incidentRowToView(row) : null
		if (!row || !incident) return { ok: false, error: 'not-found' }
		if (row.resolved_at === null) return { ok: false, error: 'not-resolved' }
		const resolvedAt = row.resolved_at
		const now = Date.now()
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(`DELETE FROM incidents WHERE id = ?`, id)
			const days = utcDaysInSpan(row.started_at, resolvedAt)
			const placeholders = days.map(() => '?').join(', ')
			const stats = this.ctx.storage.sql
				.exec<{ day: string; failed: number }>(
					`SELECT day, failed FROM daily_stats
					WHERE component = ? AND day IN (${placeholders})`,
					row.component,
					...days,
				)
				.toArray()
			const deletedSpan = { startedAt: row.started_at, resolvedAt }
			const removedFailedSamplesByDay =
				row.started_at >= now - sampleRetentionMs
					? this.countFailedSamplesByDay(row.component, deletedSpan)
					: null
			const remainingSpans =
				this.loadIncidentSpans(0, now).get(incident.component) ?? []
			for (const stat of dailyFailedAfterIncidentDelete({
				stats,
				deletedSpan,
				removedFailedSamplesByDay,
				remainingSpans,
				now,
			})) {
				this.ctx.storage.sql.exec(
					`UPDATE daily_stats SET failed = ? WHERE component = ? AND day = ?`,
					stat.failed,
					row.component,
					stat.day,
				)
			}
		})
		console.info(
			'status-incident-deleted',
			JSON.stringify({ id, component: row.component }),
		)
		return { ok: true, incident }
	}

	private countFailedSamplesByDay(
		component: string,
		span: { startedAt: number; resolvedAt: number },
	): Map<string, number> {
		const byDay = new Map<string, number>()
		for (const sample of this.ctx.storage.sql
			.exec<{ checked_at: number }>(
				`SELECT checked_at FROM samples
				WHERE component = ? AND ok = 0 AND checked_at >= ? AND checked_at < ?`,
				component,
				span.startedAt,
				span.resolvedAt,
			)
			.toArray()) {
			const day = toDay(sample.checked_at)
			byDay.set(day, (byDay.get(day) ?? 0) + 1)
		}
		return byDay
	}

	async getSnapshot(): Promise<StatusSnapshot> {
		const storedLastSuccessAt = this.readEpochMeta(executeLastSuccessMetaKey)
		const resolvedLastSuccess = await resolvePublicExecuteLastSuccess({
			now: Date.now(),
			storedLastSuccessAt,
			fetchLive: () =>
				fetchExecuteEvidenceLastSuccessAt({
					primaryOrigin: this.env.PRIMARY_ORIGIN,
				}),
			readStoredAfterFetch: () => this.readEpochMeta(executeLastSuccessMetaKey),
		})
		if (
			resolvedLastSuccess.persist &&
			resolvedLastSuccess.lastSuccessAt !== null
		) {
			this.setMeta(
				executeLastSuccessMetaKey,
				String(resolvedLastSuccess.lastSuccessAt),
			)
		}
		const now = Date.now()
		const windowStartMs = Date.parse(
			`${toDay(now - (uptimeWindowDays - 1) * 24 * 60 * 60 * 1000)}T00:00:00.000Z`,
		)
		const incidentSpans = this.loadIncidentSpans(windowStartMs, now)
		const components = statusComponents.map((component) =>
			this.buildComponentSnapshot(
				component.id,
				component.name,
				now,
				incidentSpans.get(component.id) ?? [],
			),
		)
		const overallStatus: ComponentStatus = components.some(
			(component) => component.status === 'down',
		)
			? 'down'
			: components.every((component) => component.status === 'unknown')
				? 'unknown'
				: 'operational'
		return {
			generatedAt: new Date(now).toISOString(),
			overallStatus,
			components,
			openIncidents: this.listIncidents('open'),
			recentIncidents: this.listIncidents('resolved'),
			providerIncidents: this.readProviderIncidents(now),
			productionCommit: this.getMeta(productionCommitMetaKey),
			runtimeCommit: this.getMeta(runtimeCommitMetaKey),
			jobsCommit: this.getMeta(jobsCommitMetaKey),
			executeHealth: deriveExecuteHealthView({
				now,
				...this.readExecuteHealthState(resolvedLastSuccess.lastSuccessAt),
			}),
		}
	}

	private loadIncidentSpans(
		windowStartMs: number,
		now: number,
	): Map<StatusComponentId, Array<IncidentSpan>> {
		const rows = this.ctx.storage.sql
			.exec<{
				component: string
				started_at: number
				resolved_at: number | null
			}>(
				`SELECT component, started_at, resolved_at FROM incidents
				WHERE started_at < ? AND (resolved_at IS NULL OR resolved_at >= ?)`,
				now,
				windowStartMs,
			)
			.toArray()
		const byComponent = new Map<StatusComponentId, Array<IncidentSpan>>()
		for (const row of rows) {
			if (!isStatusComponentId(row.component)) continue
			const spans = byComponent.get(row.component) ?? []
			spans.push({
				startedAt: row.started_at,
				resolvedAt: row.resolved_at,
			})
			byComponent.set(row.component, spans)
		}
		return byComponent
	}

	private buildComponentSnapshot(
		id: StatusComponentId,
		name: string,
		now: number,
		spans: ReadonlyArray<IncidentSpan>,
	): ComponentSnapshot {
		const stateRows = this.ctx.storage.sql
			.exec<{ status: string }>(
				`SELECT status FROM component_state WHERE component = ?`,
				id,
			)
			.toArray()
		const latestSample = this.ctx.storage.sql
			.exec<{ latency_ms: number | null }>(
				`SELECT latency_ms FROM samples WHERE component = ?
				ORDER BY checked_at DESC LIMIT 1`,
				id,
			)
			.toArray()[0]
		const status: ComponentStatus =
			stateRows.length === 0
				? 'unknown'
				: stateRows[0]?.status === 'down'
					? 'down'
					: 'operational'
		const statRows = this.ctx.storage.sql
			.exec<{ day: string; total: number; failed: number }>(
				`SELECT day, total, failed FROM daily_stats
				WHERE component = ? AND day >= ? ORDER BY day ASC`,
				id,
				toDay(now - (uptimeWindowDays - 1) * 24 * 60 * 60 * 1000),
			)
			.toArray()
		const statsByDay = new Map(statRows.map((row) => [row.day, row]))
		const days: Array<ComponentDayStat> = []
		for (let offset = uptimeWindowDays - 1; offset >= 0; offset -= 1) {
			const day = toDay(now - offset * 24 * 60 * 60 * 1000)
			const stat = statsByDay.get(day)
			days.push({
				day,
				total: stat?.total ?? 0,
				failed: stat?.failed ?? 0,
				incidentMinutes: incidentMinutesForDay(day, spans, now),
			})
		}
		const visibleDays = daysFromFirstSample(days)
		const total = visibleDays.reduce((sum, day) => sum + day.total, 0)
		const failed = visibleDays.reduce((sum, day) => sum + day.failed, 0)
		const uptimePct = total === 0 ? null : ((total - failed) / total) * 100
		return {
			id,
			name,
			status,
			latencyMs: latestSample?.latency_ms ?? null,
			uptimePct,
			days: visibleDays,
		}
	}

	private listIncidents(kind: 'open' | 'resolved'): Array<IncidentView> {
		const where =
			kind === 'open' ? 'resolved_at IS NULL' : 'resolved_at IS NOT NULL'
		const order = kind === 'open' ? 'started_at ASC' : 'started_at DESC'
		return this.ctx.storage.sql
			.exec<IncidentRow>(
				`SELECT id, component, started_at, resolved_at, detail, retrospective
				FROM incidents WHERE ${where} ORDER BY ${order} LIMIT ?`,
				recentIncidentLimit,
			)
			.toArray()
			.flatMap((row) => {
				const incident = incidentRowToView(row)
				return incident ? [incident] : []
			})
	}

	private loadIncidentById(id: number): IncidentView | null {
		const row = this.ctx.storage.sql
			.exec<IncidentRow>(selectIncidentByIdSql, id)
			.toArray()[0]
		if (!row) return null
		return incidentRowToView(row)
	}
}
