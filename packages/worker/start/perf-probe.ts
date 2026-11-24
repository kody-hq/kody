/**
 * Local measurement probe: records every binding round trip (D1, Durable
 * Objects, R2, KV, queues) against the HTTP request that caused it.
 *
 * Dev server only and opt-in (`VITE_KODY_PERF_PROBE=1`); `http-entry.ts` drops
 * the import from production builds. Read the records with
 * `npm run app-perf -- ssr`. See docs/contributing/app-performance.md.
 */
import { env as globalEnv } from 'cloudflare:workers'
import { getRequestContext } from '../src/request-context.ts'

type ProbeEvent = {
	binding: string
	op: string
	/** Milliseconds after the request started. */
	at: number
	/** Round-trip duration; -1 while still pending. */
	ms: number
	/** SQL text for D1, `batch(n)` for a batch. */
	detail?: string
	/** App frames that issued the call, innermost first. */
	stack?: string
}

type ProbeRecord = {
	method: string
	url: string
	startedAt: number
	headersMs?: number
	events: Array<ProbeEvent>
}

export const perfProbeDumpPath = '/__perf/dump'

const skippedBindings = new Set([
	'ASSETS',
	'CF_VERSION_METADATA',
	'LOADER',
	'APP_LOADER',
])
const records: Array<ProbeRecord> = []
const recordByRequest = new WeakMap<Request, ProbeRecord>()
const originals = new WeakMap<object, object>()
const unattributed: ProbeRecord = {
	method: '-',
	url: 'unattributed',
	startedAt: Date.now(),
	events: [],
}

function unwrap(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(unwrap)
	if (value && (typeof value === 'object' || typeof value === 'function')) {
		return originals.get(value) ?? value
	}
	return value
}

function currentRecord() {
	const request = getRequestContext()?.request
	return (request && recordByRequest.get(request)) || unattributed
}

function appFrames() {
	return (new Error().stack ?? '')
		.split('\n')
		.slice(3)
		.map((line) =>
			line
				.replace(/^\s*at\s+/, '')
				.replace(/\(?[^()\s]*\/packages\/worker\//, '(')
				.replace(/\?[^:)]*/, ''),
		)
		.filter(
			(line) =>
				!line.includes('node_modules') &&
				!line.includes('perf-probe') &&
				!line.includes('request-context.ts') &&
				!line.startsWith('async Promise.all') &&
				!line.startsWith('new Promise'),
		)
		.slice(0, 14)
		.join(' < ')
}

function wrap<T>(target: T, binding: string, label: string, sql?: string): T {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
		return target
	}
	const proxy = new Proxy(target, {
		get(_target, prop) {
			const value = Reflect.get(target, prop, target)
			if (typeof value !== 'function') return value
			if (typeof prop === 'symbol' || prop === 'then') return value.bind(target)
			return (...args: Array<unknown>) => {
				const startedAt = Date.now()
				const op = label ? `${label}.${prop}` : prop
				const result = Reflect.apply(value, target, args.map(unwrap))
				const nextSql =
					prop === 'prepare' && typeof args[0] === 'string' ? args[0] : sql
				if (result && typeof result.then === 'function') {
					const record = currentRecord()
					const event: ProbeEvent = {
						binding,
						op,
						at: startedAt - record.startedAt,
						ms: -1,
						detail:
							prop === 'batch' && Array.isArray(args[0])
								? `batch(${args[0].length})`
								: nextSql?.replace(/\s+/g, ' ').slice(0, 220),
						stack: appFrames(),
					}
					record.events.push(event)
					const settle = () => {
						event.ms = Date.now() - startedAt
					}
					Promise.resolve(result).then(settle, settle)
					return result
				}
				// Statements, stubs, and namespaces: keep following until the call
				// that actually crosses the binding.
				if (result && typeof result === 'object') {
					return wrap(result, binding, nextSql === undefined ? op : '', nextSql)
				}
				return result
			}
		},
	})
	originals.set(proxy, target)
	return proxy
}

let installed = false
function install(env: Env) {
	if (installed) return
	installed = true
	for (const bag of new Set<object>([env, globalEnv])) {
		const bindings = bag as Record<string, unknown>
		for (const [name, value] of Object.entries(bindings)) {
			if (!value || typeof value !== 'object') continue
			if (skippedBindings.has(name) || originals.has(value)) continue
			try {
				bindings[name] = wrap(value, name, '')
			} catch (error) {
				console.warn(
					`perf-probe: cannot wrap ${name}; its round trips are missing from every count.`,
					String(error),
				)
			}
		}
	}
}

/** Starts a record for `request`. Call the result when response headers are ready. */
export function startPerfProbe(request: Request, env: Env) {
	install(env)
	const record: ProbeRecord = {
		method: request.method,
		url: request.url,
		startedAt: Date.now(),
		events: [],
	}
	recordByRequest.set(request, record)
	records.push(record)
	return () => {
		record.headersMs = Date.now() - record.startedAt
	}
}

/** Returns every record since the previous dump and clears them. */
export function dumpPerfProbe() {
	const dumped = [...records.splice(0), { ...unattributed }]
	unattributed.events = []
	return Response.json(dumped)
}
