/**
 * Post-deploy multi-region health check for `kody.codes`.
 *
 * The deploy healthcheck runs from one US runner, so a Cloudflare colo that
 * cannot load the new Worker version (for example error 1105 across Western
 * Europe on 2026-11-20) still passes. This script asks Globalping probes in
 * several European and US cities to GET `/health`, retries for a propagation
 * window, and fails when two or more probes get a Cloudflare error page or
 * any probe still serves a different commit after the window. When the
 * Globalping API itself is unavailable or rate-limited it warns and passes.
 *
 * Env: `REGIONAL_HEALTH_URL` (default https://kody.codes/health),
 * `EXPECTED_COMMIT_SHA` (required), `REGIONAL_HEALTH_WINDOW_SECONDS`
 * (default 150).
 */
import { appendFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

export const globalpingApi = 'https://api.globalping.io/v1/measurements'

export const regionalProbeLocations = [
	{ city: 'Paris', country: 'FR' },
	{ city: 'London', country: 'GB' },
	{ city: 'Amsterdam', country: 'NL' },
	{ city: 'Frankfurt', country: 'DE' },
	{ city: 'Madrid', country: 'ES' },
	{ city: 'Chicago', country: 'US' },
	{ city: 'Ashburn', country: 'US' },
] as const

/** Two or more Cloudflare error responses fail the deploy. */
export const outageProbeThreshold = 2

type GlobalpingResult = {
	probe?: { city?: string; country?: string; network?: string }
	result?: {
		status?: string
		statusCode?: number | null
		rawHeaders?: string | null
		rawBody?: string | null
		headers?: Record<string, string | Array<string>> | null
	}
}

export type ProbeVerdict = {
	location: string
	colo: string | null
	cfRay: string | null
	status: number | null
	bodySnippet: string
	kind: 'ok' | 'outage' | 'stale' | 'unhealthy' | 'probe-failed'
	commitSha: string | null
}

export type MeasurementVerdict =
	| { kind: 'pass'; probes: Array<ProbeVerdict> }
	| { kind: 'fail'; reasons: Array<string>; probes: Array<ProbeVerdict> }
	| { kind: 'inconclusive'; reason: string; probes: Array<ProbeVerdict> }

function headerValue(
	result: NonNullable<GlobalpingResult['result']>,
	name: string,
): string | null {
	const fromObject = result.headers?.[name]
	if (typeof fromObject === 'string') return fromObject
	if (Array.isArray(fromObject) && fromObject[0]) return fromObject[0]
	for (const line of (result.rawHeaders ?? '').split(/\r?\n/)) {
		const index = line.indexOf(':')
		if (index > 0 && line.slice(0, index).trim().toLowerCase() === name) {
			return line.slice(index + 1).trim()
		}
	}
	return null
}

function snippet(body: string): string {
	const flat = body.replace(/\s+/g, ' ').trim()
	return flat.length > 120 ? `${flat.slice(0, 120)}...` : flat
}

function readCommitSha(body: string): string | null {
	try {
		const json = JSON.parse(body) as { ok?: unknown; commitSha?: unknown }
		return json.ok === true && typeof json.commitSha === 'string'
			? json.commitSha
			: null
	} catch {
		return null
	}
}

export function classifyProbe(
	entry: GlobalpingResult,
	expectedCommitSha: string,
): ProbeVerdict {
	const probe = entry.probe ?? {}
	const location =
		[probe.city, probe.country].filter(Boolean).join(', ') || 'unknown'
	const result = entry.result ?? {}
	const cfRay = headerValue(result, 'cf-ray')
	const colo = cfRay?.split('-').at(-1)?.toUpperCase() ?? null
	const body = result.rawBody ?? ''
	const status =
		typeof result.statusCode === 'number' ? result.statusCode : null
	const base = {
		location,
		colo,
		cfRay,
		status,
		bodySnippet: snippet(body),
		commitSha: null,
	}
	if (result.status !== 'finished' || status === null) {
		return { ...base, kind: 'probe-failed' }
	}
	if (status === 503 || /error code: 1105/i.test(body)) {
		return { ...base, kind: 'outage' }
	}
	if (status !== 200) return { ...base, kind: 'unhealthy' }
	const commitSha = readCommitSha(body)
	return {
		...base,
		commitSha,
		kind: commitSha === expectedCommitSha ? 'ok' : 'stale',
	}
}

export function evaluateMeasurement(
	results: Array<GlobalpingResult>,
	expectedCommitSha: string,
): MeasurementVerdict {
	const probes = results.map((entry) => classifyProbe(entry, expectedCommitSha))
	const answered = probes.filter((probe) => probe.kind !== 'probe-failed')
	if (answered.length === 0) {
		return { kind: 'inconclusive', reason: 'no probe answered', probes }
	}
	const reasons: Array<string> = []
	const outages = probes.filter((probe) => probe.kind === 'outage')
	if (outages.length >= outageProbeThreshold) {
		reasons.push(
			`${outages.length} probes got a Cloudflare 503 or error code 1105`,
		)
	}
	const unhealthy = probes.filter((probe) => probe.kind === 'unhealthy')
	if (unhealthy.length >= outageProbeThreshold) {
		reasons.push(`${unhealthy.length} probes got a non-200 response`)
	}
	const stale = probes.filter((probe) => probe.kind === 'stale')
	if (stale.length > 0) {
		reasons.push(
			`${stale.length} probe(s) served a commit other than ${expectedCommitSha}`,
		)
	}
	return reasons.length > 0
		? { kind: 'fail', reasons, probes }
		: { kind: 'pass', probes }
}

export function formatProbe(probe: ProbeVerdict): string {
	return [
		`${probe.location}`,
		`colo=${probe.colo ?? 'unknown'}`,
		`cf-ray=${probe.cfRay ?? 'none'}`,
		`status=${probe.status ?? 'none'}`,
		`kind=${probe.kind}`,
		probe.commitSha ? `commit=${probe.commitSha}` : null,
		`body="${probe.bodySnippet}"`,
	]
		.filter(Boolean)
		.join(' ')
}

type MeasureOutcome =
	| { ok: true; results: Array<GlobalpingResult> }
	| { ok: false; reason: string }

export async function runGlobalpingMeasurement(input: {
	target: URL
	fetchImpl: typeof fetch
	sleep: (ms: number) => Promise<void>
	pollIntervalMs?: number
	pollAttempts?: number
}): Promise<MeasureOutcome> {
	const { target, fetchImpl, sleep } = input
	let created: Response
	try {
		created = await fetchImpl(globalpingApi, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				type: 'http',
				target: target.hostname,
				inProgressUpdates: false,
				locations: regionalProbeLocations.map((location) => ({
					...location,
					limit: 1,
				})),
				measurementOptions: {
					protocol: target.protocol === 'http:' ? 'HTTP' : 'HTTPS',
					request: {
						method: 'GET',
						path: target.pathname,
						query: target.search.replace(/^\?/, '') || undefined,
					},
				},
			}),
			signal: AbortSignal.timeout(15_000),
		})
	} catch (error) {
		return { ok: false, reason: `create failed: ${String(error)}` }
	}
	if (!created.ok) {
		return { ok: false, reason: `create returned HTTP ${created.status}` }
	}
	const { id } = (await created.json()) as { id?: string }
	if (!id) return { ok: false, reason: 'create returned no measurement id' }
	const pollAttempts = input.pollAttempts ?? 30
	for (let attempt = 0; attempt < pollAttempts; attempt++) {
		await sleep(input.pollIntervalMs ?? 1000)
		let polled: Response
		try {
			polled = await fetchImpl(`${globalpingApi}/${id}`, {
				signal: AbortSignal.timeout(15_000),
			})
		} catch (error) {
			return { ok: false, reason: `poll failed: ${String(error)}` }
		}
		if (!polled.ok) {
			return { ok: false, reason: `poll returned HTTP ${polled.status}` }
		}
		const measurement = (await polled.json()) as {
			status?: string
			results?: Array<GlobalpingResult>
		}
		if (measurement.status !== 'in-progress') {
			return { ok: true, results: measurement.results ?? [] }
		}
	}
	return { ok: false, reason: `measurement ${id} did not finish` }
}

export type RegionalCheckOutcome = {
	exitCode: 0 | 1
	lines: Array<string>
}

export async function runRegionalHealthCheck(input: {
	url: string
	expectedCommitSha: string
	windowMs: number
	retryDelayMs?: number
	fetchImpl?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	log?: (line: string) => void
}): Promise<RegionalCheckOutcome> {
	const fetchImpl = input.fetchImpl ?? fetch
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
	const now = input.now ?? Date.now
	const lines: Array<string> = []
	const log = (line: string) => {
		lines.push(line)
		input.log?.(line)
	}
	const target = new URL(input.url)
	const deadline = now() + input.windowMs
	let lastConclusive: MeasurementVerdict | null = null
	let lastProblem = ''
	for (let attempt = 1; ; attempt++) {
		const measured = await runGlobalpingMeasurement({
			target,
			fetchImpl,
			sleep,
		})
		if (!measured.ok) {
			lastProblem = measured.reason
			log(`Attempt ${attempt}: Globalping unavailable (${measured.reason}).`)
		} else {
			const verdict = evaluateMeasurement(
				measured.results,
				input.expectedCommitSha,
			)
			log(`Attempt ${attempt}: ${verdict.kind}`)
			for (const probe of verdict.probes) log(`  ${formatProbe(probe)}`)
			if (verdict.kind === 'pass') {
				log(
					`Regional health ok from ${verdict.probes.length} probes at ${input.expectedCommitSha}.`,
				)
				return { exitCode: 0, lines }
			}
			if (verdict.kind === 'inconclusive') lastProblem = verdict.reason
			else lastConclusive = verdict
		}
		if (now() + (input.retryDelayMs ?? 20_000) > deadline) break
		await sleep(input.retryDelayMs ?? 20_000)
	}
	if (lastConclusive?.kind === 'fail') {
		log(
			`::error title=Regional health check failed::${target.href} is not healthy in every region after ${Math.round(input.windowMs / 1000)}s: ${lastConclusive.reasons.join('; ')}.`,
		)
		for (const probe of lastConclusive.probes) {
			if (probe.kind === 'ok' || probe.kind === 'probe-failed') continue
			log(`::error title=Regional probe ${probe.kind}::${formatProbe(probe)}`)
		}
		log(
			'::error title=Remediation::Re-run this deploy job. A new run attempt uploads a fresh Worker version of the same build (new split deploy tag), which cleared the 2026-11-20 error 1105 outage. If it fails again, follow docs/contributing/rollback.md.',
		)
		return { exitCode: 1, lines }
	}
	log(
		`::warning title=Regional health check skipped::Globalping gave no conclusive result (${lastProblem || 'unknown'}); not failing the deploy.`,
	)
	return { exitCode: 0, lines }
}

async function main() {
	const expectedCommitSha = process.env.EXPECTED_COMMIT_SHA?.trim()
	if (!expectedCommitSha) {
		console.error('Missing EXPECTED_COMMIT_SHA.')
		process.exit(1)
	}
	const windowSeconds = Number(process.env.REGIONAL_HEALTH_WINDOW_SECONDS)
	const outcome = await runRegionalHealthCheck({
		url: process.env.REGIONAL_HEALTH_URL?.trim() || 'https://kody.codes/health',
		expectedCommitSha,
		windowMs:
			(Number.isFinite(windowSeconds) && windowSeconds > 0
				? windowSeconds
				: 150) * 1000,
		log: (line) => console.log(line),
	})
	const summaryPath = process.env.GITHUB_STEP_SUMMARY
	if (summaryPath) {
		const rows = outcome.lines
			.filter((line) => !line.startsWith('::'))
			.join('\n')
		appendFileSync(
			summaryPath,
			`### Regional health check\n\n\`\`\`\n${rows}\n\`\`\`\n`,
		)
	}
	process.exit(outcome.exitCode)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
