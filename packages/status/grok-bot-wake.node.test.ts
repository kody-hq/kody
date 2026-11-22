import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	decideGrokBotWake,
	sendGrokBotWake,
	serializeGrokBotWakeBody,
	type WakeIncident,
} from './grok-bot-wake.ts'
import { jobsProbeOrigin } from './probes.ts'
import { StatusStore, type StatusWorkerEnv } from './status-store.ts'

const wakeUrl = 'https://hooks.example.com/grok-bot/wake'
const start = Date.parse('2026-11-20T05:11:24.000Z')

type WakeBody = { id: string; name: string; prompt: string }
type WakeCall = { authorization: string | null; raw: string; body: WakeBody }

function createStore(envOverrides: Partial<StatusWorkerEnv> = {}) {
	const db = new DatabaseSync(':memory:')
	const pending: Array<Promise<unknown>> = []
	const ctx = {
		storage: {
			sql: {
				exec(query: string, ...bindings: Array<SQLInputValue>) {
					const rows = db.prepare(query).all(...bindings)
					return { toArray: () => rows }
				},
			},
			transactionSync<T>(fn: () => T): T {
				db.exec('BEGIN')
				try {
					const result = fn()
					db.exec('COMMIT')
					return result
				} catch (error) {
					db.exec('ROLLBACK')
					throw error
				}
			},
		},
		blockConcurrencyWhile(fn: () => Promise<void>) {
			return fn()
		},
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise)
		},
	}
	const env = {
		PRIMARY_ORIGIN: 'https://kody.codes',
		PACKAGE_APP_ORIGIN: 'https://kody.run',
		STATUS_PAGE_URL: 'https://status.kody.codes',
		ALERT_EMAIL_TO: 'ops@example.com',
		ALERT_EMAIL_FROM: 'status@example.com',
		STATUS_GROK_BOT_WAKE_URL: wakeUrl,
		STATUS_GROK_BOT_WAKE_TOKEN: 'wake-token',
		STATUS_GROK_BOT_ID: '6519d644-b6ac-4e61-989c-3d96d0b63cca',
		STATUS_GROK_BOT_NAME: 'cole',
		...envOverrides,
	} as StatusWorkerEnv
	const store = new StatusStore(ctx as unknown as DurableObjectState, env)
	const flush = async () => {
		await Promise.all(pending.splice(0))
	}
	return { db, store, flush }
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

type OriginDownKind = 'html-503' | 'measured'

/**
 * `html-503`: Cloudflare 1105 page on every kody.codes URL (Western Europe
 * 2026-11-20). Storage cards skip because `/health/components` is not JSON.
 * `measured`: parseable per-binding failures so app, mcp, and storage all
 * open in one tick.
 */
function stubNetwork(kind: OriginDownKind = 'html-503') {
	const state = { down: true }
	const wakes: Array<WakeCall> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString()
			if (url === wakeUrl) {
				const raw = String(init?.body)
				wakes.push({
					authorization: new Headers(init?.headers).get('authorization'),
					raw,
					body: JSON.parse(raw) as WakeBody,
				})
				return json({ ok: true })
			}
			if (url === 'https://kody.run/__runtime/health') {
				return json({ status: 'ok', commitSha: 'b'.repeat(40) })
			}
			if (url === `${jobsProbeOrigin}/health`) {
				return json({ ok: true, commit: 'c'.repeat(40) })
			}
			if (url === `${jobsProbeOrigin}/health/components`) {
				return json({
					ok: true,
					components: [{ id: 'jobs_db', ok: true, latencyMs: 2 }],
				})
			}
			if (url.startsWith('https://kody.codes/')) {
				if (state.down && kind === 'html-503') {
					return new Response('error code: 1105', {
						status: 503,
						headers: { 'content-type': 'text/plain; charset=UTF-8' },
					})
				}
				if (url === 'https://kody.codes/health') {
					return state.down
						? json({ ok: false }, 503)
						: json({ ok: true, commitSha: 'a'.repeat(40) })
				}
				if (url === 'https://kody.codes/mcp') {
					if (state.down) return new Response(null, { status: 503 })
					return new Response(null, {
						status: 401,
						headers: { 'WWW-Authenticate': 'Bearer resource_metadata="x"' },
					})
				}
				if (url === 'https://kody.codes/health/components') {
					return state.down
						? json(
								{
									ok: false,
									components: [
										{ id: 'app_db', ok: false, error: 'timeout' },
										{ id: 'kv', ok: false, error: 'timeout' },
										{ id: 'assets', ok: false, error: 'timeout' },
									],
								},
								503,
							)
						: json({
								ok: true,
								components: [
									{ id: 'app_db', ok: true, latencyMs: 1 },
									{ id: 'kv', ok: true, latencyMs: 1 },
									{ id: 'assets', ok: true, latencyMs: 1 },
								],
							})
				}
			}
			return new Response('unavailable', { status: 503 })
		}),
	)
	return { state, wakes }
}

async function tick(
	store: StatusStore,
	flush: () => Promise<void>,
	index: number,
) {
	vi.setSystemTime(start + index * 60_000)
	await store.runProbes()
	await flush()
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(start)
	vi.spyOn(console, 'info').mockImplementation(() => {})
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

test('origin HTML 503 opens app and mcp only, one wake, and recovery sends one all-clear', async () => {
	const { state, wakes } = stubNetwork('html-503')
	const { db, store, flush } = createStore()

	for (let index = 0; index < 6; index++) await tick(store, flush, index)

	expect(wakes).toHaveLength(1)
	const [opened] = wakes
	expect(opened!.authorization).toBe('Bearer wake-token')
	expect(opened!.body).toMatchObject({
		id: '6519d644-b6ac-4e61-989c-3d96d0b63cca',
		name: 'cole',
	})
	const prompt = opened!.body.prompt
	expect(prompt).toContain('App & API (app, incident #')
	expect(prompt).toContain('MCP endpoint (mcp,')
	expect(prompt).toContain('2 components opened an incident')
	expect(prompt).toContain('HTTP 503')
	expect(prompt).toContain('started 2026-11-20T05:13:24.000Z')
	expect(prompt).toContain('Status page: https://status.kody.codes')
	expect(prompt).not.toContain('Primary database')
	expect(prompt).not.toContain('Key-value storage')
	expect(prompt).not.toContain('Asset storage')
	expect(prompt).not.toContain('Package runtime')
	expect(prompt).not.toContain('Jobs')

	state.down = false
	for (let index = 6; index < 10; index++) await tick(store, flush, index)

	expect(wakes).toHaveLength(2)
	expect(wakes[1]!.body.prompt).toContain('Kody status all clear')
	expect(wakes[1]!.body.prompt).toContain('resolved 2026-11-20T05:18:24.000Z')
	expect(db.prepare(`SELECT kind FROM bot_wakes ORDER BY id`).all()).toEqual([
		{ kind: 'opened' },
		{ kind: 'all_clear' },
	])
})

test('five measured components opening in one tick give one wake', async () => {
	const { wakes } = stubNetwork('measured')
	const { store, flush } = createStore()

	for (let index = 0; index < 6; index++) await tick(store, flush, index)

	expect(wakes).toHaveLength(1)
	const prompt = wakes[0]!.body.prompt
	for (const name of [
		'App & API (app, incident #',
		'MCP endpoint (mcp,',
		'Primary database (app_db,',
		'Key-value storage (kv,',
		'Asset storage (assets,',
	]) {
		expect(prompt).toContain(name)
	}
	expect(prompt).toContain('5 components opened an incident')
	expect(prompt).not.toContain('Package runtime')
	expect(prompt).not.toContain('Jobs')
})

test('unset wake secrets skip with one warning and never throw', async () => {
	const { wakes } = stubNetwork()
	const { store, flush } = createStore({
		STATUS_GROK_BOT_WAKE_URL: undefined,
		STATUS_GROK_BOT_WAKE_TOKEN: undefined,
	})
	const warn = vi.mocked(console.warn)

	for (let index = 0; index < 6; index++) await tick(store, flush, index)

	expect(wakes).toHaveLength(0)
	const skipped = warn.mock.calls.filter(
		([label]) => label === 'status-grok-bot-wake-skipped',
	)
	expect(skipped).toHaveLength(1)
	expect(String(skipped[0]![1])).toContain('wake-secrets-unset')
})

function incident(id: number, overrides: Partial<WakeIncident> = {}) {
	return {
		id,
		component: 'app',
		detail: 'HTTP 503',
		startedAt: start,
		...overrides,
	} satisfies WakeIncident
}

test('wake decision dedupes woken ids, waits for every incident before all-clear, and honors the daily cap', () => {
	const base = {
		wokenIncidentIds: new Set<number>(),
		pendingAllClear: [],
		wakesSentToday: 0,
		dailyLimit: 12,
	}
	expect(
		decideGrokBotWake({ ...base, openIncidents: [incident(1), incident(2)] }),
	).toEqual({ kind: 'opened', incidents: [incident(1), incident(2)] })
	expect(
		decideGrokBotWake({
			...base,
			openIncidents: [incident(1), incident(2)],
			wokenIncidentIds: new Set([1, 2]),
		}),
	).toBeNull()
	expect(
		decideGrokBotWake({
			...base,
			openIncidents: [incident(2)],
			wokenIncidentIds: new Set([1, 2]),
			pendingAllClear: [incident(1)],
		}),
	).toBeNull()
	expect(
		decideGrokBotWake({
			...base,
			openIncidents: [],
			wokenIncidentIds: new Set([1, 2]),
			pendingAllClear: [incident(1), incident(2)],
		}),
	).toEqual({ kind: 'all_clear', incidents: [incident(1), incident(2)] })
	expect(
		decideGrokBotWake({
			...base,
			openIncidents: [incident(3)],
			wakesSentToday: 12,
		}),
	).toBeNull()
})

test('wake transport escapes placeholder braces, rejects insecure urls, and reports http errors', async () => {
	const raw = serializeGrokBotWakeBody({
		id: 'x',
		name: 'cole',
		prompt: 'detail {{secret:foo}} and {{{x',
	})
	expect(raw).not.toContain('{{')
	expect(JSON.parse(raw).prompt).toBe('detail {{secret:foo}} and {{{x')

	const base = {
		token: 't',
		botId: 'id',
		botName: 'cole',
		prompt: 'p',
	}
	expect(
		await sendGrokBotWake({ ...base, url: 'http://hooks.example.com' }),
	).toEqual({ ok: false, error: 'insecure-wake-url' })
	expect(
		await sendGrokBotWake({
			...base,
			url: wakeUrl,
			fetchImpl: (async () =>
				new Response('no', { status: 500 })) as unknown as typeof fetch,
		}),
	).toEqual({ ok: false, error: 'http-500' })
})

test('a webhook that never answers times out softly', async () => {
	const hang = ((_input: RequestInfo | URL, init?: RequestInit) =>
		new Promise((_, reject) => {
			init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
		})) as typeof fetch
	const result = await sendGrokBotWake({
		url: wakeUrl,
		token: 't',
		botId: 'id',
		botName: 'cole',
		prompt: 'p',
		fetchImpl: hang,
		timeoutMs: 20,
	})
	expect(result).toEqual({ ok: false, error: 'timeout', timedOut: true })
})
