#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2] ?? '.')
const report = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'))
const quantile = (values, p) => {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
	return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null
}
const distribution = (values) => ({
	count: values.filter(Number.isFinite).length,
	min: quantile(values, 0.000001),
	p50: quantile(values, 0.5),
	p95: quantile(values, 0.95),
	p99: quantile(values, 0.99),
	max: quantile(values, 1),
})
const summaries = report.config.targets.map((target) => {
	const runs = report.results.filter((run) => run.label === target.label)
	const navigation = runs.flatMap((run) => run.navigation)
	const checks = runs.flatMap((run) => run.accountChecks)
	return {
		label: target.label,
		runs: runs.length,
		completed: runs.filter((run) => run.finishedAt).length,
		failures: runs.flatMap((run) => (run.failure ? [run.failure] : [])),
		uncaughtPageErrors: runs.flatMap((run) => run.errors),
		coldRequests: distribution(
			runs.map((run) => run.summary?.coldEntry.requests),
		),
		coldEncodedBytes: distribution(
			runs.map((run) => run.summary?.coldEntry.encodedBytes),
		),
		navigation: Object.fromEntries(
			['public', 'account'].map((segment) => {
				const subset = navigation.filter((item) => item.segment === segment)
				return [
					segment,
					{
						count: subset.length,
						domReadyMs: distribution(subset.map((item) => item.domReadyMs)),
						visibleReadyMs: distribution(
							subset.map((item) => item.visibleReadyMs),
						),
						reloads: subset.filter((item) => item.fullDocumentReload).length,
						headingGapCheckpoints: subset.reduce(
							(sum, item) => sum + item.headingGaps.length,
							0,
						),
					},
				]
			}),
		),
		races: {
			total: runs.reduce((sum, run) => sum + run.races.length, 0),
			failed: runs.flatMap((run) => run.races.filter((race) => !race.passed)),
		},
		checks: Object.fromEntries(
			[
				'mutationPersisted',
				'focusFresh',
				'reconnectRefresh',
				'draftRetained',
				'documentRetained',
				'jobsSearchRetained',
				'retentionMutationAccepted',
				'retentionPersisted',
			].map((key) => [
				key,
				{
					passed: checks.filter((check) => check[key] === true).length,
					total: checks.length,
				},
			]),
		),
		retentionTimingMs: Object.fromEntries(
			[
				'pendingDomMs',
				'pendingFrameMs',
				'postResponseHeadersMs',
				'postAcceptedMs',
				'successFrameMs',
				'persistedConfirmationMs',
			].map((key) => [
				key,
				distribution(checks.map((check) => check.retentionTiming?.[key])),
			]),
		),
		traffic: runs.map((run) => ({
			round: run.round,
			groups: Object.fromEntries(
				[
					'cold-entry',
					'public-navigation',
					'account-navigation',
					'account-check',
					'history',
					'race',
					'idle',
				].map((prefix) => {
					const phases = Object.entries(
						run.summary?.trafficByPhase ?? {},
					).filter(
						([phase]) => phase === prefix || phase.startsWith(prefix + '-'),
					)
					const requests = phases.reduce(
						(sum, [, value]) => sum + value.requests,
						0,
					)
					const encodedBytes = phases.reduce(
						(sum, [, value]) => sum + value.encodedBytes,
						0,
					)
					return [
						prefix,
						{
							observedPhases: phases.length,
							requests,
							encodedBytes,
							requestsPerObservedPhase: phases.length
								? requests / phases.length
								: null,
							bytesPerObservedPhase: phases.length
								? encodedBytes / phases.length
								: null,
						},
					]
				}),
			),
			note: 'Request phase is assigned when the request starts. Groups include background work in that phase; only completed-request bytes are known. Observed phase counts omit phases without requests and are not user-operation counts.',
		})),
		requestFailures: runs.flatMap((run) =>
			run.requests
				.filter((request) => request.error)
				.map((request) => ({
					round: run.round,
					phase: request.phase,
					url: request.url,
					type: request.type,
					status: request.status,
					error: request.error,
					canceled: request.canceled,
				})),
		),
		cleanup: runs.map((run) => ({
			round: run.round,
			profileRestored: run.profileRestored,
			retentionRestored: run.retentionRestored,
			failure: run.cleanupFailure,
		})),
		memory: runs.map((run) => ({ round: run.round, samples: run.memory })),
	}
})
writeFileSync(
	join(directory, 'summary.json'),
	JSON.stringify(
		{
			config: {
				...report.config,
				targets: report.config.targets.map(({ authenticated, ...target }) => ({
					...target,
					initialStorageStateProvided: authenticated,
				})),
			},
			caveats: report.caveats,
			summaries,
		},
		null,
		2,
	) + '\n',
)
const fmt = (value) =>
	value === null || value === undefined
		? 'unavailable'
		: Number(value.toFixed(2)).toLocaleString('en-US')
const lines = [
	'# Local session measurements',
	'',
	'Values are descriptive local production measurements. Initial storage state is absent because each authenticated workload logs in after its public segment. Cold means a fresh anonymous browser context/cache, not a cold Worker or Cloudflare startup. Cold byte accounting includes the observation window and preloads, but partial bytes from canceled requests are not included in completed-request totals. Navigation is click to matching content in an animation frame, not physical pixel presentation. Mutation pending and success frame timings likewise observe DOM/style readiness. Public and authenticated timings are kept separate. Different freshness timeout costs cause different operation counts, so navigation counts are not throughput and total memory/traffic needs that context.',
	'',
	'| Target | Completed runs | Public nav count | Public visible p50 / p95 / p99 ms | Account nav count | Account visible p50 / p95 / p99 ms | Cold requests p50 | Cold bytes p50 |',
	'| --- | ---: | ---: | --- | ---: | --- | ---: | ---: |',
]
for (const item of summaries) {
	const triple = (values) =>
		[values.p50, values.p95, values.p99].map(fmt).join(' / ')
	lines.push(
		`| ${item.label} | ${item.completed}/${item.runs} | ${item.navigation.public.count} | ${triple(item.navigation.public.visibleReadyMs)} | ${item.navigation.account.count} | ${triple(item.navigation.account.visibleReadyMs)} | ${fmt(item.coldRequests.p50)} | ${fmt(item.coldEncodedBytes.p50)} |`,
	)
}
lines.push(
	'',
	'Raw samples, failures, mutation feedback/completion distributions, correctness checks, cleanup results and memory trajectories are in [summary.json](summary.json) and [results.json](results.json). Memory covers the primary page renderer, not total browser, OS or editor-tab memory. Natural heap, idle samples, final activity and forced GC remain distinct. Uncaught page errors and network failures are recorded, but caught console errors are not captured. This run does not establish a leak-free application, edge delivery speed or behavior under a large jobs dataset.',
	'',
)
writeFileSync(join(directory, 'SUMMARY.md'), lines.join('\n'))
