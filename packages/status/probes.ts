import {
	statusComponentIds,
	type ProbeOutcome,
	type StatusComponentId,
} from './status-types.ts'

/**
 * Active probes the status worker runs every scheduled tick. Direct probes
 * cover the worker surfaces (app, MCP, package runtime, jobs); the
 * `/health/components` endpoint on the main worker reports storage bindings.
 * Only product-affecting bindings become public cards (`app_db`, `kv`,
 * `assets`), and only from a parseable `/health/components` JSON report.
 * An origin HTTP 503 or unreachable fetch is the App card, not a storage
 * outage. `/health/components` may also carry timestamp-only MCP execute
 * evidence; that field is observational and never starts a paid execute.
 * Jobs is reached over a service binding (or an optional
 * non-public origin fallback), never through the main app and never via a
 * user-facing jobs hostname.
 */

const probeTimeoutMs = 10_000

/** Synthetic origin used with the JOBS service binding. Not a public URL. */
export const jobsProbeOrigin = 'https://kody-jobs.internal'

type ProbeConfig = {
	primaryOrigin: string
	packageAppOrigin: string
	/** Origin used for jobs `/health` and `/health/components`. */
	jobsOrigin?: string
	fetcher?: typeof fetch
	/** When set, used only for jobs probes (service binding). */
	jobsFetcher?: typeof fetch
}

type HealthComponentsBody = {
	ok?: boolean
	components?: Array<{
		id?: string
		ok?: boolean
		latencyMs?: number
		error?: string
	}>
	executeEvidence?: {
		lastSuccessAt?: string | null
	}
}

const componentEndpointIds = [
	'app_db',
	'kv',
	'assets',
] as const satisfies ReadonlyArray<StatusComponentId>

function truncateDetail(detail: string): string {
	return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
}

async function timedFetch(
	fetcher: typeof fetch,
	url: string,
): Promise<
	| { response: Response; latencyMs: number }
	| { response: null; latencyMs: number; error: string }
> {
	const startedAt = Date.now()
	try {
		const response = await fetcher(url, {
			redirect: 'manual',
			signal: AbortSignal.timeout(probeTimeoutMs),
			headers: {
				'User-Agent': 'kody-status-prober',
				'Cache-Control': 'no-cache',
			},
		})
		return { response, latencyMs: Date.now() - startedAt }
	} catch (error) {
		return {
			response: null,
			latencyMs: Date.now() - startedAt,
			error: truncateDetail(
				error instanceof Error ? error.message : String(error),
			),
		}
	}
}

type CommitBody = {
	ok?: boolean
	status?: string
	commitSha?: string
	commit?: string
}

function readCommitSha(value: string | null | undefined): string | null {
	const commitSha = value?.trim()
	if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha)) return null
	return commitSha.toLowerCase()
}

async function readJsonBody<T>(response: Response): Promise<T | null> {
	try {
		return (await response.json()) as T
	} catch {
		return null
	}
}

async function probeApp(
	fetcher: typeof fetch,
	primaryOrigin: string,
): Promise<{ outcome: ProbeOutcome; productionCommitSha: string | null }> {
	const result = await timedFetch(fetcher, `${primaryOrigin}/health`)
	if (!result.response) {
		return {
			outcome: {
				component: 'app',
				ok: false,
				latencyMs: result.latencyMs,
				detail: result.error,
			},
			productionCommitSha: null,
		}
	}
	const body = await readJsonBody<CommitBody>(result.response)
	const bodyOk = body?.ok === true
	const ok = result.response.ok && bodyOk
	return {
		outcome: {
			component: 'app',
			ok,
			latencyMs: result.latencyMs,
			detail: ok ? null : `HTTP ${result.response.status}`,
		},
		productionCommitSha: readCommitSha(body?.commitSha),
	}
}

async function probeMcp(
	fetcher: typeof fetch,
	primaryOrigin: string,
): Promise<ProbeOutcome> {
	const result = await timedFetch(fetcher, `${primaryOrigin}/mcp`)
	if (!result.response) {
		return {
			component: 'mcp',
			ok: false,
			latencyMs: result.latencyMs,
			detail: result.error,
		}
	}
	// An unauthenticated GET must produce the OAuth bearer challenge; anything
	// else (a 5xx, or a 401 with the wrong scheme) means the MCP surface is
	// broken.
	const challenge = result.response.headers.get('WWW-Authenticate') ?? ''
	const ok = result.response.status === 401 && challenge.startsWith('Bearer')
	return {
		component: 'mcp',
		ok,
		latencyMs: result.latencyMs,
		detail: ok ? null : `HTTP ${result.response.status}`,
	}
}

async function probePackageRuntime(
	fetcher: typeof fetch,
	packageAppOrigin: string,
): Promise<{ outcome: ProbeOutcome; runtimeCommitSha: string | null }> {
	const result = await timedFetch(
		fetcher,
		`${packageAppOrigin}/__runtime/health`,
	)
	if (!result.response) {
		return {
			outcome: {
				component: 'package_apps',
				ok: false,
				latencyMs: result.latencyMs,
				detail: result.error,
			},
			runtimeCommitSha: null,
		}
	}
	const body = await readJsonBody<CommitBody>(result.response)
	const ok = result.response.ok && body?.status === 'ok'
	return {
		outcome: {
			component: 'package_apps',
			ok,
			latencyMs: result.latencyMs,
			detail: ok ? null : `HTTP ${result.response.status}`,
		},
		runtimeCommitSha: readCommitSha(body?.commitSha),
	}
}

async function probeJobs(
	fetcher: typeof fetch,
	jobsOrigin: string,
): Promise<{ outcome: ProbeOutcome; jobsCommitSha: string | null }> {
	const [health, components] = await Promise.all([
		timedFetch(fetcher, `${jobsOrigin}/health`),
		timedFetch(fetcher, `${jobsOrigin}/health/components`),
	])
	if (!health.response) {
		return {
			outcome: {
				component: 'jobs',
				ok: false,
				latencyMs: health.latencyMs,
				detail: health.error,
			},
			jobsCommitSha: null,
		}
	}
	const healthBody = await readJsonBody<CommitBody>(health.response)
	const healthOk = health.response.ok && healthBody?.ok === true
	const jobsCommitSha = readCommitSha(healthBody?.commit)
	if (!healthOk) {
		return {
			outcome: {
				component: 'jobs',
				ok: false,
				latencyMs: health.latencyMs,
				detail: `HTTP ${health.response.status}`,
			},
			jobsCommitSha,
		}
	}
	if (!components.response) {
		return {
			outcome: {
				component: 'jobs',
				ok: false,
				latencyMs: components.latencyMs,
				detail: components.error,
			},
			jobsCommitSha,
		}
	}
	const componentsBody = await readJsonBody<HealthComponentsBody>(
		components.response,
	)
	const jobsDb = componentsBody?.components?.find(
		(entry) => entry.id === 'jobs_db',
	)
	const componentsOk =
		components.response.ok &&
		(componentsBody?.ok === true || jobsDb?.ok === true)
	if (!componentsOk) {
		const detail =
			jobsDb?.ok === false
				? (jobsDb.error ?? 'error')
				: `HTTP ${components.response.status}`
		return {
			outcome: {
				component: 'jobs',
				ok: false,
				latencyMs:
					typeof jobsDb?.latencyMs === 'number'
						? jobsDb.latencyMs
						: components.latencyMs,
				detail,
			},
			jobsCommitSha,
		}
	}
	return {
		outcome: {
			component: 'jobs',
			ok: true,
			latencyMs: health.latencyMs,
			detail: null,
		},
		jobsCommitSha,
	}
}

function skippedStorageOutcomes(detail: string): Array<ProbeOutcome> {
	return componentEndpointIds.map((component) => ({
		component,
		ok: false,
		latencyMs: null,
		detail,
		skip: true,
	}))
}

async function probeStorageComponents(
	fetcher: typeof fetch,
	primaryOrigin: string,
): Promise<{
	outcomes: Array<ProbeOutcome>
	executeLastSuccessAt: number | null
}> {
	const result = await timedFetch(fetcher, `${primaryOrigin}/health/components`)
	if (!result.response) {
		return {
			outcomes: skippedStorageOutcomes('unreachable'),
			executeLastSuccessAt: null,
		}
	}
	const body = await readJsonBody<HealthComponentsBody>(result.response)
	if (!body || !Array.isArray(body.components)) {
		return {
			outcomes: skippedStorageOutcomes(`HTTP ${result.response.status}`),
			executeLastSuccessAt: null,
		}
	}
	return {
		outcomes: componentEndpointIds.map((component) => {
			const reported = body.components?.find((entry) => entry.id === component)
			if (!reported) {
				return { component, ok: false, latencyMs: null, detail: 'unreported' }
			}
			return {
				component,
				ok: reported.ok === true,
				latencyMs:
					typeof reported.latencyMs === 'number' ? reported.latencyMs : null,
				detail: reported.ok === true ? null : (reported.error ?? 'error'),
			}
		}),
		executeLastSuccessAt: parseExecuteLastSuccessAt(
			body.executeEvidence?.lastSuccessAt,
		),
	}
}

const executeEvidenceRefreshTimeoutMs = 2_000

function parseExecuteLastSuccessAt(
	value: string | null | undefined,
): number | null {
	if (!value) return null
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : null
}

/**
 * Cheap origin executeEvidence read. Never starts MCP execute. Used by
 * public status snapshots when stored last-success is already stale, and
 * shares the same parser as the minute cron.
 */
export async function fetchExecuteEvidenceLastSuccessAt(input: {
	primaryOrigin: string
	fetcher?: typeof fetch
	timeoutMs?: number
}): Promise<number | null> {
	const fetcher = input.fetcher ?? fetch
	try {
		const response = await fetcher(`${input.primaryOrigin}/health/components`, {
			redirect: 'manual',
			signal: AbortSignal.timeout(
				input.timeoutMs ?? executeEvidenceRefreshTimeoutMs,
			),
			headers: {
				'User-Agent': 'kody-status-prober',
				'Cache-Control': 'no-cache',
			},
		})
		const body = await readJsonBody<HealthComponentsBody>(response)
		return parseExecuteLastSuccessAt(body?.executeEvidence?.lastSuccessAt)
	} catch {
		return null
	}
}

export type ProbeRunResult = {
	outcomes: Array<ProbeOutcome>
	productionCommitSha: string | null
	runtimeCommitSha: string | null
	jobsCommitSha: string | null
	executeLastSuccessAt: number | null
}

export async function runAllProbes(
	config: ProbeConfig,
): Promise<ProbeRunResult> {
	const fetcher = config.fetcher ?? fetch
	const jobsFetcher = config.jobsFetcher ?? fetcher
	const jobsOrigin = config.jobsOrigin ?? jobsProbeOrigin
	const [app, mcp, packageRuntime, jobs, storage] = await Promise.all([
		probeApp(fetcher, config.primaryOrigin),
		probeMcp(fetcher, config.primaryOrigin),
		probePackageRuntime(fetcher, config.packageAppOrigin),
		probeJobs(jobsFetcher, jobsOrigin),
		probeStorageComponents(fetcher, config.primaryOrigin),
	])
	const outcomes = [
		app.outcome,
		mcp,
		packageRuntime.outcome,
		jobs.outcome,
		...storage.outcomes,
	]
	const covered = new Set(outcomes.map((outcome) => outcome.component))
	for (const component of statusComponentIds) {
		if (!covered.has(component)) {
			outcomes.push({
				component,
				ok: false,
				latencyMs: null,
				detail: 'unprobed',
			})
		}
	}
	return {
		outcomes,
		productionCommitSha: app.productionCommitSha,
		runtimeCommitSha: packageRuntime.runtimeCommitSha,
		jobsCommitSha: jobs.jobsCommitSha,
		executeLastSuccessAt: storage.executeLastSuccessAt,
	}
}
