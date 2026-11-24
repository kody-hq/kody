import { AsyncLocalStorage } from 'node:async_hooks'
import { fnv1a32 } from '@kody-internal/shared/fnv1a.ts'
import { timeD1RoundTrips } from '#worker/d1-round-trip-timing.ts'
import { getRequestContext } from '#worker/request-context.ts'

/**
 * Lets a browser page load read `APP_DB` from the nearest D1 read replica.
 *
 * A request reads from a replica only when it is a GET or HEAD, the
 * `d1-replica-reads` flag selected it, and {@link allowReplicaReads} opted it
 * in. Every other request, including every mutation, reads the primary
 * exactly as before. No call site changes: the binding is replaced by a
 * router that sends each call to the request's D1 session or to the primary.
 *
 * Read-your-writes: while the flag is on, a non-GET response sets the
 * `kody_d1` cookie to the primary's D1 bookmark, taken after the request's
 * writes. A replica read carrying it starts its session at that bookmark, so
 * it reads a replica only once that replica has the browser's writes. When
 * no bookmark could be taken the cookie says so, and reads start on the
 * primary. Reads never set the cookie, so a slow read cannot replace the
 * mark a newer write left.
 *
 * A GET that writes (a token link, a consent page) must not decide that
 * write from a replica. The first write of a replica request is refused and
 * {@link renderWithReplicaReads} runs the request again on the primary, so
 * no write follows a replica read. Once the response has been returned a
 * retry is impossible: such a write runs on the primary and is logged.
 */
export const d1ReplicaReadsFlagKey = 'd1-replica-reads'
export const d1FreshReadCookieName = 'kody_d1'
const freshReadCookieSeconds = 60
/** Cookie value when the primary gave no bookmark: start on the primary. */
const noBookmark = '1'
// The cookie is the browser's to send, so only a bookmark's shape is trusted.
const bookmarkPattern = /^[0-9a-f]{8}(-[0-9a-f]{8}){2}-[0-9a-f]{32}$/i

function startFromCookie(value: string | undefined): D1SessionConstraint {
	if (value === undefined) return 'first-unconstrained'
	return bookmarkPattern.test(value)
		? (value as D1SessionConstraint)
		: 'first-primary'
}
const rolloutTtlMs = 30_000

export type D1ReplicaReadState = {
	/** Null: this request reads the primary. */
	start: D1SessionConstraint | null
	/** Whether the flag is on at all, so writes leave the cookie. */
	rolloutOn: boolean
	allowed: boolean
	session?: D1DatabaseSession
	/** A write was refused; the request must run again on the primary. */
	retry?: string
	responded?: boolean
}

type Rollout = { enabled: boolean; percent: number | null }
type RolloutCache = {
	value: Rollout
	loadedAt: number
	loading?: Promise<void>
}

const off: Rollout = { enabled: false, percent: null }
const rollouts = new WeakMap<object, RolloutCache>()
const realDatabases = new WeakMap<object, D1Database>()

/**
 * Read the flag's global row from the primary and keep it for this isolate.
 * Requests never wait on it: until the first read lands the flag is off, and
 * a change reaches an isolate within {@link rolloutTtlMs}.
 */
export function refreshD1ReplicaReadRollout(env: Env): Promise<void> {
	const real = realDatabases.get(env)
	if (!real) return Promise.resolve()
	const cache = rollouts.get(real) ?? { value: off, loadedAt: 0 }
	rollouts.set(real, cache)
	if (cache.loading) return cache.loading
	cache.loadedAt = Date.now()
	cache.loading = (async () => {
		try {
			const row = await real
				.prepare(
					`SELECT enabled, rollout_percent FROM feature_flags WHERE key = ?`,
				)
				.bind(d1ReplicaReadsFlagKey)
				.first<{ enabled: number; rollout_percent: number | null }>()
			cache.value = row
				? { enabled: row.enabled === 1, percent: row.rollout_percent }
				: off
		} catch {
			// A database that cannot answer the flag read keeps reading the primary.
			cache.value = off
		} finally {
			cache.loading = undefined
		}
	})()
	return cache.loading
}

function currentRollout(env: Env) {
	const real = realDatabases.get(env)
	const cache = real && rollouts.get(real)
	if (!cache || Date.now() - cache.loadedAt > rolloutTtlMs) {
		void refreshD1ReplicaReadRollout(env)
	}
	return cache?.value ?? off
}

function readCookie(request: Request, name: string) {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const separator = part.indexOf('=')
		if (separator < 0) continue
		if (part.slice(0, separator).trim() === name)
			return part.slice(separator + 1).trim()
	}
	return undefined
}

function inRollout(request: Request, rollout: Rollout) {
	if (!rollout.enabled) return false
	if (rollout.percent === null) return true
	// Sticky for a signed-in browser; a signed-out request is bucketed alone.
	const subject = readCookie(request, 'kody_session') ?? crypto.randomUUID()
	return fnv1a32(`${d1ReplicaReadsFlagKey}:${subject}`) % 100 < rollout.percent
}

function isRead(request: Request) {
	return request.method === 'GET' || request.method === 'HEAD'
}

/** Decide, before the request reads anything, how it may read `APP_DB`. */
export function beginD1ReplicaReads(request: Request, env: Env) {
	const context = getRequestContext(request)
	if (!context || !realDatabases.has(env)) return
	const rollout = currentRollout(env)
	const selected = isRead(request) && inRollout(request, rollout)
	context.d1ReplicaReads = {
		start: selected
			? startFromCookie(readCookie(request, d1FreshReadCookieName))
			: null,
		rolloutOn: rollout.enabled,
		allowed: false,
	}
}

/**
 * Opt the current request in. Call it only where a stale read cannot decide
 * what gets written: a page with no server handler of its own, or a GET
 * server function. Token links, OAuth callbacks, and webhooks never call it.
 */
export function allowReplicaReads(request?: Request) {
	const state = getRequestContext(request)?.d1ReplicaReads
	if (state?.start) state.allowed = true
}

type StatementMethod = 'first' | 'all' | 'run' | 'raw'
type RoutedStatement = {
	primary: D1PreparedStatement
	sql: string
	values: Array<unknown> | undefined
}
const routedStatements = new WeakMap<object, RoutedStatement>()

const primaryScope = new AsyncLocalStorage<true>()

/**
 * Run `work` against the primary whatever the request reads from. Only for
 * a write nothing in the response depends on and no permission gates, such
 * as telemetry; it does not make the request run again.
 */
export function runOnD1Primary<Result>(work: () => Result): Result {
	return primaryScope.run(true, work)
}

class D1ReplicaReadWriteError extends Error {
	constructor() {
		super('A request reading a D1 replica wrote; retrying it on the primary.')
	}
}

/** Anything not plainly a read is treated as a write. */
function isReadStatement(sql: string | undefined) {
	if (!sql) return false
	if (/^\s*(SELECT|EXPLAIN)\b/i.test(sql)) return true
	return (
		/^\s*WITH\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
	)
}

/**
 * The session this call reads from, or undefined for the primary. Throws
 * when a write would follow a replica read in a request that can still be
 * run again.
 */
function requestSession(real: D1Database, sqls: Array<string | undefined>) {
	const state = getRequestContext()?.d1ReplicaReads
	if (!state?.allowed || !state.start) return undefined
	if (primaryScope.getStore()) return undefined
	const write = sqls.find((sql) => !isReadStatement(sql))
	if (sqls.length > 0 && write === undefined) {
		// One session per request, whichever copy of the binding asks first.
		state.session ??= real.withSession(state.start)
		return state.session
	}
	// From the first write on, the request reads and writes the primary.
	state.allowed = false
	if (!state.session) return undefined
	const statement = (write ?? 'exec').trim().slice(0, 80)
	if (!state.responded) {
		state.retry = statement
		throw new D1ReplicaReadWriteError()
	}
	console.warn('D1 write after a replica read was not retried:', statement)
	return undefined
}

function statementFor(
	session: D1DatabaseSession | undefined,
	statement: D1PreparedStatement,
) {
	const routed = routedStatements.get(statement)
	if (!routed) return statement
	if (!session) return routed.primary
	const prepared = session.prepare(routed.sql)
	return routed.values ? prepared.bind(...routed.values) : prepared
}

function routeStatement(real: D1Database, routed: RoutedStatement) {
	const call =
		(method: StatementMethod) =>
		async (...args: Array<unknown>) =>
			(
				statementFor(requestSession(real, [routed.sql]), statement)[method] as (
					...methodArgs: Array<unknown>
				) => Promise<unknown>
			)(...args)
	const statement = {
		bind: (...values: Array<unknown>) =>
			routeStatement(real, {
				primary: routed.primary.bind(...values),
				sql: routed.sql,
				values,
			}),
		first: call('first'),
		all: call('all'),
		run: call('run'),
		raw: call('raw'),
	} as unknown as D1PreparedStatement
	routedStatements.set(statement, routed)
	return statement
}

/**
 * A `D1Database` that sends each call to the current request's replica
 * session when the request opted in, and to `real` otherwise.
 */
export function routeD1ReplicaReads(real: D1Database): D1Database {
	return {
		prepare: (sql: string) =>
			routeStatement(real, {
				primary: real.prepare(sql),
				sql,
				values: undefined,
			}),
		batch: async (statements: Array<D1PreparedStatement>) => {
			const session = requestSession(
				real,
				statements.map((statement) => routedStatements.get(statement)?.sql),
			)
			return (session ?? real).batch(
				statements.map((statement) => statementFor(session, statement)),
			)
		},
		exec: async (query: string) => {
			requestSession(real, [])
			return real.exec(query)
		},
		dump: () => real.dump(),
		withSession: (
			constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
		) => real.withSession(constraintOrBookmark),
	} as unknown as D1Database
}

const installedEnvs = new WeakSet<object>()

/**
 * Route and time `APP_DB` for every request this Worker env serves. Replaces
 * the binding in place, once, so the env object keeps its identity.
 */
export function installD1ReplicaReads(env: Env | undefined) {
	if (!env || typeof env !== 'object') return
	try {
		if (installedEnvs.has(env)) return
		installedEnvs.add(env)
		if (!env.APP_DB) return
		const real = env.APP_DB
		realDatabases.set(env, real)
		env.APP_DB = timeD1RoundTrips(routeD1ReplicaReads(real))
	} catch (error) {
		console.warn('D1 replica reads are not installed:', String(error))
	}
}

/**
 * The cookie a response to a write carries while the flag is on: the
 * primary's bookmark after the request's writes, so the browser's next
 * replica reads are at least that fresh.
 */
export async function d1FreshReadSetCookie(
	request: Request,
	env: Env,
): Promise<string | undefined> {
	const state = getRequestContext(request)?.d1ReplicaReads
	if (!state?.rolloutOn || isRead(request)) return undefined
	let value = noBookmark
	try {
		const session = realDatabases.get(env)?.withSession('first-primary')
		await session?.prepare('SELECT 1').run()
		const bookmark = session?.getBookmark()
		if (bookmark && bookmarkPattern.test(bookmark)) value = bookmark
	} catch {
		// Without a bookmark the browser's next reads start on the primary.
	}
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
	return `${d1FreshReadCookieName}=${value}; Path=/; Max-Age=${freshReadCookieSeconds}; HttpOnly; SameSite=Lax${secure}`
}

function takePrimaryRetry(request: Request) {
	const context = getRequestContext(request)
	const state = context?.d1ReplicaReads
	if (!context || !state?.retry) return false
	console.warn(
		`D1 replica read retried on the primary: ${request.method} ${new URL(request.url).pathname} wrote (${state.retry})`,
	)
	state.retry = undefined
	state.start = null
	state.session = undefined
	// Everything memoized so far may have come from the replica.
	context.memo.clear()
	context.serverTiming.push({ name: 'd1-primary-retry', durationMs: 0 })
	return true
}

/**
 * Render a request, and render it again on the primary when it tried to
 * write after reading a replica. Only GET and HEAD requests read replicas,
 * so the second run has no body to replay.
 */
export async function renderWithReplicaReads(
	request: Request,
	render: () => Promise<Response>,
): Promise<Response> {
	let response: Response
	try {
		response = await render()
	} catch (error) {
		if (!takePrimaryRetry(request)) throw error
		return render()
	}
	if (takePrimaryRetry(request)) {
		void response.body?.cancel().catch(() => undefined)
		return render()
	}
	const state = getRequestContext(request)?.d1ReplicaReads
	if (state) state.responded = true
	return response
}
