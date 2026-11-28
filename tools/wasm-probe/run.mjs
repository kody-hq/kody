// Wasm production probe driver (CI only, never merged). Mode comes from
// run.json or argv[2]: permissions | probe | billing | cleanup.
import { appendFile, readFile, writeFile } from 'node:fs/promises'

import { cloudflare, probePrefix, sweepProbeWorkers } from './cloudflare.mjs'

const here = new URL('./', import.meta.url)
const config = JSON.parse(await readFile(new URL('run.json', here), 'utf8'))
const mode = process.argv[2] ?? config.mode
const env = process.env
const cf = cloudflare({
	token: env.CLOUDFLARE_API_TOKEN,
	accountId: env.CLOUDFLARE_ACCOUNT_ID,
})
const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? 1)
const scriptName = `${probePrefix}${env.GITHUB_RUN_ID ?? 'local'}${attempt > 1 ? `-${attempt}` : ''}`
const compatibilityDate = '2026-04-16'
const childCompatibilityFlags = [
	'nodejs_compat',
	'global_fetch_strictly_public',
	'enhanced_error_serialization',
	'enable_request_signal',
]
const day = 24 * 60 * 60 * 1000
const results = { mode, scriptName, startedAt: new Date().toISOString() }
const calledIds = new Set()

function mask(value) {
	if (value) console.log(`::add-mask::${value}`)
}
mask(env.CLOUDFLARE_ACCOUNT_ID)

async function deployProbe() {
	const token = crypto.randomUUID().replaceAll('-', '')
	mask(token)
	const subdomain = await cf.subdomain()
	mask(subdomain)
	await cf.upload({
		name: scriptName,
		mainModule: 'probe.js',
		compatibilityDate,
		bindings: [{ type: 'worker_loader', name: 'LOADER' }],
		modules: {
			'probe.js': await readFile(new URL('probe-worker.js', here), 'utf8'),
			'wasm.js': await readFile(new URL('wasm.js', here), 'utf8'),
			'config.js': [
				`export const token = ${JSON.stringify(token)}`,
				`export const childCompatibilityDate = ${JSON.stringify(compatibilityDate)}`,
				`export const childCompatibilityFlags = ${JSON.stringify(childCompatibilityFlags)}`,
			].join('\n'),
		},
	})
	const endpoint = `https://${scriptName}.${subdomain}.workers.dev/${token}/run`
	const deadline = Date.now() + 180_000
	let last
	while (Date.now() < deadline) {
		last = await call({ scenario: 'hello', id: 'hello-v1' }, endpoint)
		if (last.ok) return { endpoint, hello: last }
		await new Promise((r) => setTimeout(r, 5000))
	}
	throw new Error(
		`probe Worker never became reachable: ${JSON.stringify(last).slice(0, 400)}`,
	)
}

let probeEndpoint
async function call(spec, endpoint = probeEndpoint) {
	calledIds.add(spec.id)
	const started = Date.now()
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(spec),
			signal: AbortSignal.timeout(120_000),
		})
		const text = await response.text()
		try {
			return { ...JSON.parse(text), clientMs: Date.now() - started }
		} catch {
			return {
				ok: false,
				error: `parent HTTP ${response.status}: ${text.slice(0, 300)}`,
				clientMs: Date.now() - started,
			}
		}
	} catch (error) {
		return {
			ok: false,
			error: `client: ${String(error)}`,
			clientMs: Date.now() - started,
		}
	}
}

function stats(values) {
	if (!values.length) return null
	const sorted = [...values].sort((a, b) => a - b)
	const pick = (q) =>
		sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
	return {
		n: sorted.length,
		min: sorted[0],
		p50: pick(0.5),
		p90: pick(0.9),
		max: sorted.at(-1),
	}
}

function short(result) {
	if (result.ok)
		return typeof result.body === 'string'
			? result.body
			: JSON.stringify(result.body)
	return result.error ?? `HTTP ${result.status}: ${JSON.stringify(result.body)}`
}

const datasetField = 'workersInvocationsByOwnerAndScriptGroups'
const typeRef = '{ name kind ofType { name kind ofType { name kind } } }'
const typeQuery = `query($name: String!) { __type(name: $name) { fields { name args { name type ${typeRef} } type ${typeRef} } inputFields { name } } }`

function unwrap(type) {
	let t = type
	while (t && !t.name) t = t.ofType
	return t?.name ?? null
}

async function typeInfo(name) {
	const r = await cf.graphql(typeQuery, { name })
	return (
		r.data?.__type ?? {
			error: r.errors?.map((e) => e.message) ?? r.raw ?? 'not found',
		}
	)
}

let schemaCache
async function datasetSchema() {
	if (schemaCache) return schemaCache
	const account = await typeInfo('Account')
	const field = account.fields?.find((f) => f.name === datasetField)
	if (!field)
		return (schemaCache = {
			error: account.error ?? `${datasetField} not on Account`,
		})
	const filterArg = field.args.find((a) => a.name === 'filter')
	const filterType = unwrap(filterArg?.type)
	const row = await typeInfo(unwrap(field.type))
	const rowFields = {}
	for (const f of row.fields ?? []) {
		const t = unwrap(f.type)
		if (!t) continue
		const info = await typeInfo(t)
		rowFields[f.name] = info.fields?.map((x) => x.name) ?? info.error
	}
	const filter = filterType ? await typeInfo(filterType) : null
	schemaCache = {
		args: field.args.map((a) => a.name),
		filterType: filterType
			? `${filterType}${filterArg.type.kind === 'NON_NULL' ? '!' : ''}`
			: null,
		rowFields,
		filterFields:
			filter?.inputFields?.map((f) => f.name) ?? filter?.error ?? null,
	}
	return schemaCache
}

async function dynamicCounts(filter) {
	const schema = await datasetSchema()
	if (!schema.filterType)
		return { errors: [schema.error ?? 'no filter type'], rows: null }
	const dims = (
		Array.isArray(schema.rowFields?.dimensions)
			? schema.rowFields.dimensions
			: []
	).filter((d) => ['date', 'scriptName'].includes(d))
	const query = `query($accountTag: string!, $filter: ${schema.filterType}) {
	viewer { accounts(filter: { accountTag: $accountTag }) {
		${datasetField}(limit: 10000, filter: $filter) {
			${dims.length ? `dimensions { ${dims.join(' ')} }` : ''}
			uniq { distinctDynamicWorkerCount }
		}
	} }
}`
	const response = await cf.graphql(query, {
		accountTag: env.CLOUDFLARE_ACCOUNT_ID,
		filter,
	})
	const rows = response.data?.viewer?.accounts?.[0]?.[datasetField] ?? null
	return {
		errors:
			response.errors?.map((e) => e.message) ??
			(response.raw ? [response.raw] : null),
		rows:
			rows?.map((row) => ({
				date: row.dimensions?.date ?? filter.date ?? null,
				scriptName: row.dimensions?.scriptName ?? filter.scriptName ?? null,
				count: row.uniq?.distinctDynamicWorkerCount,
			})) ?? null,
	}
}

function isoDate(ms) {
	return new Date(ms).toISOString().slice(0, 10)
}

function recentFilter(extra = {}) {
	return {
		date_geq: isoDate(Date.now() - 2 * day),
		date_leq: isoDate(Date.now()),
		...extra,
	}
}

async function analyticsChecks() {
	const out = { schema: await datasetSchema() }
	out.accountWideLast2Days = await dynamicCounts(recentFilter())
	if (
		Array.isArray(out.schema.filterFields) &&
		out.schema.filterFields.includes('scriptName')
	) {
		out.deletedProbeScripts = {}
		for (const name of config.deletedScriptsToRead ?? []) {
			out.deletedProbeScripts[name] = await dynamicCounts(
				recentFilter({ scriptName: name }),
			)
		}
	}
	return out
}

async function pollDeletedScriptAnalytics() {
	const polls = []
	for (let i = 0; i < 12; i += 1) {
		await new Promise((r) => setTimeout(r, 60_000))
		const counts = await dynamicCounts(recentFilter({ scriptName }))
		polls.push({ at: new Date().toISOString(), ...counts })
		if (counts.rows?.some((row) => row.count > 0)) break
	}
	return polls
}

async function deleteOwnWorker() {
	const result = await cf.deleteScript(scriptName)
	const remaining = (await cf.listScripts()).filter(
		(s) => s.name === scriptName,
	)
	return { ...result, stillListed: remaining.length > 0 }
}

async function runPermissions() {
	results.tokenVerify = await cf.verifyToken()
	const deployed = await deployProbe()
	probeEndpoint = deployed.endpoint
	results.deployAndWorkersDev = 'ok'
	results.dynamicWorkerHello = short(deployed.hello)
	results.wasmBasic = short(await call({ scenario: 'basic', id: 'basic-v1' }))
	results.analytics = await analyticsChecks()
	results.ownWorkerDelete = await deleteOwnWorker()
	results.deletedAt = new Date().toISOString()
	results.ownDeletedScriptAnalytics = await pollDeletedScriptAnalytics()
}

async function runProbe() {
	const deployed = await deployProbe()
	probeEndpoint = deployed.endpoint
	results.basic = await call({ scenario: 'basic', id: 'basic-v1' })
	results.topLevel = {}
	for (const scenario of [
		'tl-sync-bytes',
		'tl-await-module',
		'tl-await-bytes',
		'tl-await-compile-bytes',
	]) {
		results.topLevel[scenario] = await call({
			scenario,
			id: scenario,
			timeoutMs: 15000,
		})
	}

	// Startup limit: calibrate busy() iterations per ms at request time, then
	// run that much work at the child's top level.
	await call({ scenario: 'busy', id: 'busy-cal', topIterations: 0 })
	let n = 2e7
	let best = Infinity
	for (let i = 0; i < 6; i += 1) {
		const r = await call({
			scenario: 'busy',
			id: 'busy-cal',
			topIterations: 0,
			query: `?n=${n}`,
		})
		if (!r.ok) {
			results.calibrationError = short(r)
			break
		}
		if (r.ms < 50) {
			n *= 10
			best = Infinity
			continue
		}
		best = Math.min(best, r.ms)
	}
	results.calibration = {
		iterations: n,
		bestMs: best,
		iterationsPerMs: Math.round(n / best),
	}
	results.startup = []
	if (Number.isFinite(best)) {
		for (const targetMs of [250, 600, 900, 1500, 3000]) {
			const topIterations = Math.round((n / best) * targetMs)
			const r = await call({
				scenario: 'busy',
				id: `startup-${targetMs}`,
				topIterations,
				timeoutMs: 30000,
			})
			results.startup.push({
				targetMs,
				topIterations,
				ok: r.ok,
				ms: r.ms,
				detail: r.ok ? 'ok' : short(r),
			})
		}
	}

	results.sizes = []
	for (const padKind of ['code', 'data']) {
		const mibs = [1, 4, 8, 16]
		for (let index = 0; index < mibs.length; index += 1) {
			const mib = mibs[index]
			const cold = []
			for (let i = 0; i < 5; i += 1) {
				cold.push(
					await call({
						scenario: 'size',
						padKind,
						mib,
						id: `cold-${padKind}-${mib}-${i}`,
						timeoutMs: 30000,
					}),
				)
			}
			const warmId = `warm-${padKind}-${mib}`
			const first = await call({
				scenario: 'size',
				padKind,
				mib,
				id: warmId,
				timeoutMs: 30000,
			})
			const warm = []
			if (first.ok) {
				for (let i = 0; i < 20; i += 1)
					warm.push(
						await call({
							scenario: 'size',
							padKind,
							mib,
							id: warmId,
							timeoutMs: 30000,
						}),
					)
			}
			const okCold = cold.filter((r) => r.ok)
			const okWarm = warm.filter((r) => r.ok)
			results.sizes.push({
				padKind,
				mib,
				coldOk: `${okCold.length}/${cold.length}`,
				coldMs: stats(okCold.map((r) => r.ms)),
				coldLoadCallbackMs: stats(
					okCold.map((r) => r.loadMs).filter((v) => v !== null),
				),
				coldClientMs: stats(okCold.map((r) => r.clientMs)),
				warmOk: `${okWarm.length}/${warm.length}`,
				warmMs: stats(okWarm.map((r) => r.ms)),
				warmReloads: okWarm.filter((r) => r.loadCalled).length,
				memoryBytes: okCold[0]?.body?.memoryBytes ?? null,
				firstError: [...cold, first, ...warm].find((r) => !r.ok)
					? short([...cold, first, ...warm].find((r) => !r.ok))
					: null,
			})
			if (mib === 16 && okCold.length > 0) mibs.push(24, 32)
		}
	}

	results.hold = []
	for (const mib of [16, 32]) {
		const id = `hold-data-${mib}`
		const first = await call({
			scenario: 'size',
			padKind: 'data',
			mib,
			id,
			timeoutMs: 30000,
		})
		if (!first.ok) {
			results.hold.push({ mib, maxHeld: 0, error: short(first) })
			continue
		}
		let maxHeld = 1
		let error = null
		for (let i = 0; i < 10; i += 1) {
			const r = await call({
				scenario: 'size',
				padKind: 'data',
				mib,
				id,
				query: '?hold=1',
				timeoutMs: 30000,
			})
			if (!r.ok) {
				error = short(r)
				break
			}
			maxHeld = Math.max(maxHeld, r.body.held)
		}
		results.hold.push({ mib, maxHeld, error })
	}

	results.billing = {
		date: isoDate(Date.now()),
		expectedDistinctDynamicWorkers: calledIds.size,
		note: 'one per distinct id (same code per id); warm ids were called 21 times each and must count once',
	}
	if (config.keepWorker) {
		results.ownWorkerDelete = {
			kept: true,
			reason: 'kept idle until the next-day billing read',
		}
	} else {
		results.ownWorkerDelete = await deleteOwnWorker()
	}
}

async function runBilling() {
	const { date, scriptName: target, expected } = config.billing
	const counts = await dynamicCounts({ date, scriptName: target })
	results.billingRead = {
		date,
		scriptName: target,
		expected,
		errors: counts.errors,
		rows: counts.rows,
	}
	results.sweep = await sweepProbeWorkers(cf, {})
}

async function runCleanup() {
	results.sweep = await sweepProbeWorkers(cf, {})
}

function renderMarkdown() {
	const lines = [
		`### Wasm production probe: \`${mode}\``,
		'',
		`Run: ${env.GITHUB_SERVER_URL ?? ''}/${env.GITHUB_REPOSITORY ?? ''}/actions/runs/${env.GITHUB_RUN_ID ?? ''} · Worker \`${scriptName}\``,
		'',
	]
	if (results.fatal) lines.push(`**Fatal:** ${results.fatal}`, '')
	if (mode === 'probe' && results.basic) {
		const b = results.basic.body ?? {}
		lines.push('| Check | Result |', '| --- | --- |')
		lines.push(
			`| 1. \`{ wasm }\` module, nested \`lib/nested/add.wasm\` | ${results.basic.ok ? `add(2,3)=${b.nestedAdd}, Module=${b.moduleIsWebAssemblyModule}` : short(results.basic)} |`,
		)
		lines.push(
			`| 1. root-relative \`.__kody_wasm__/<sha256>.wasm\` | ${results.basic.ok ? `add(2,3)=${b.rootRelativeAdd}` : '-'} |`,
		)
		for (const [label, value] of Object.entries(b.requestTime ?? {}))
			lines.push(`| 2. request time: \`${label}\` | ${value} |`)
		for (const [scenario, r] of Object.entries(results.topLevel ?? {}))
			lines.push(
				`| 3. top level: \`${scenario}\` | ${r.ok ? r.body.result : short(r)} |`,
			)
		lines.push(
			'',
			`Calibration: ${JSON.stringify(results.calibration)}${results.calibrationError ? `, error: ${results.calibrationError}` : ''}`,
			'',
		)
		lines.push(
			'**6. Startup limit (top-level `busy()` after top-level instantiate)**',
			'',
			'| Target CPU ms | OK | Wall ms | Detail |',
			'| --- | --- | --- | --- |',
		)
		for (const s of results.startup ?? [])
			lines.push(
				`| ${s.targetMs} | ${s.ok} | ${s.ms} | ${String(s.detail).slice(0, 160)} |`,
			)
		lines.push(
			'',
			'**4/5. Size ceiling and latency** (ms measured in the parent Worker; client ms includes the CI round trip)',
			'',
		)
		lines.push(
			'| Pad | MiB | Cold ok | Cold p50/p90/max | Load callback p50 | Client cold p50 | Warm ok | Warm p50/p90/max | Warm reloads | Linear memory | First error |',
			'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
		)
		const f = (s) => (s ? `${s.p50}/${s.p90}/${s.max}` : '-')
		for (const s of results.sizes ?? [])
			lines.push(
				`| ${s.padKind} | ${s.mib} | ${s.coldOk} | ${f(s.coldMs)} | ${s.coldLoadCallbackMs?.p50 ?? '-'} | ${s.coldClientMs?.p50 ?? '-'} | ${s.warmOk} | ${f(s.warmMs)} | ${s.warmReloads} | ${s.memoryBytes ?? '-'} | ${s.firstError ? String(s.firstError).slice(0, 160) : ''} |`,
			)
		lines.push(
			'',
			'**5. Peak memory: data-padded instances held in one isolate (each copies its segment into linear memory)**',
			'',
		)
		for (const h of results.hold ?? [])
			lines.push(
				`- ${h.mib} MiB: held ${h.maxHeld} instance(s)${h.error ? `, then: ${String(h.error).slice(0, 200)}` : ' (no failure within 11)'}`,
			)
		lines.push(
			'',
			`**7. Billing shape:** expected \`distinctDynamicWorkerCount\` for \`${scriptName}\` on ${results.billing?.date} UTC = ${results.billing?.expectedDistinctDynamicWorkers} (${results.billing?.note}).`,
			'',
		)
	}
	lines.push(
		'<details><summary>Raw results</summary>',
		'',
		'```json',
		JSON.stringify(results, null, 2).slice(0, 50000),
		'```',
		'</details>',
	)
	return lines.join('\n')
}

async function postComment(issueNumber, body) {
	if (!env.GITHUB_TOKEN || !issueNumber) return
	const response = await fetch(
		`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${issueNumber}/comments`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.GITHUB_TOKEN}`,
				accept: 'application/vnd.github+json',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ body }),
		},
	)
	console.log(`comment on #${issueNumber}: HTTP ${response.status}`)
}

async function findPhase1aPr() {
	if (!env.GITHUB_TOKEN) return null
	const q = encodeURIComponent(
		`repo:${env.GITHUB_REPOSITORY} is:pr in:title "Wasm 1a"`,
	)
	const response = await fetch(`https://api.github.com/search/issues?q=${q}`, {
		headers: {
			authorization: `Bearer ${env.GITHUB_TOKEN}`,
			accept: 'application/vnd.github+json',
		},
	})
	const json = await response.json()
	return json.items?.find((item) => /wasm 1a/i.test(item.title))?.number ?? null
}

let exitCode = 0
try {
	if (mode === 'permissions') await runPermissions()
	else if (mode === 'probe') await runProbe()
	else if (mode === 'billing') await runBilling()
	else if (mode === 'cleanup') await runCleanup()
	else throw new Error(`unknown mode ${mode}`)
} catch (error) {
	results.fatal = String(error?.stack ?? error).slice(0, 1500)
	exitCode = 1
	if (mode !== 'cleanup' && !config.keepWorker)
		results.ownWorkerDelete = await deleteOwnWorker().catch((e) => String(e))
}
try {
	results.sweepOlderThan24h = await sweepProbeWorkers(cf, {
		olderThanMs: day,
		keep: config.keepWorker ? [scriptName] : [],
	})
	results.probeWorkersRemaining = (await cf.listScripts())
		.filter((s) => s.name.startsWith(probePrefix))
		.map((s) => s.name)
} catch (error) {
	results.sweepError = String(error)
	exitCode = 1
}
if (results.ownWorkerDelete && results.ownWorkerDelete.deleted === false)
	exitCode = 1

const markdown = renderMarkdown()
console.log(markdown)
await writeFile('wasm-probe-results.json', JSON.stringify(results, null, 2))
if (env.GITHUB_STEP_SUMMARY)
	await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
await postComment(env.PROBE_PR, markdown)
if (mode === 'probe' || mode === 'billing') {
	const phase1a = await findPhase1aPr()
	results.phase1aPr = phase1a
	if (phase1a) await postComment(phase1a, markdown)
	else
		console.log('No "Wasm 1a" PR found; results posted on the probe PR only.')
}
process.exit(exitCode)
