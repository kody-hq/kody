import { getRequestContext } from '#worker/request-context.ts'
import type { ServerTimingEntry } from '#worker/server-timing.ts'

/**
 * Measurement only: what a request's D1 round trips cost as the Worker sees
 * them (wall time) next to what D1 says the SQL took and which database
 * instance answered. The difference is time spent getting to D1 and back,
 * which is the number that decides whether read replicas would help.
 *
 * Every call is forwarded unchanged and its result returned as is.
 */
export type D1RoundTripTotals = {
	calls: number
	wallMs: number
	/** Calls whose result carried D1 `meta` (`all`, `run`, `batch`). */
	reportedCalls: number
	reportedWallMs: number
	reportedSqlMs: number
	servedBy: Set<string>
}

const realStatements = new WeakMap<object, D1PreparedStatement>()
const timedDatabases = new WeakSet<object>()

function totalsForCurrentRequest() {
	const context = getRequestContext()
	if (!context) return undefined
	context.d1 ??= {
		calls: 0,
		wallMs: 0,
		reportedCalls: 0,
		reportedWallMs: 0,
		reportedSqlMs: 0,
		servedBy: new Set(),
	}
	return context.d1
}

function metaOf(result: unknown): Array<D1Meta> {
	const results = Array.isArray(result) ? result : [result]
	return results.flatMap((entry) => {
		const meta = (entry as { meta?: D1Meta } | null)?.meta
		return meta && typeof meta === 'object' ? [meta] : []
	})
}

function servedByToken(meta: D1Meta) {
	if (!meta.served_by_region) return undefined
	const role =
		meta.served_by_primary === undefined
			? undefined
			: meta.served_by_primary
				? 'primary'
				: 'replica'
	return [meta.served_by_region, meta.served_by_colo, role]
		.filter(Boolean)
		.join('-')
}

function timed<Result>(roundTrip: Promise<Result>): Promise<Result> {
	const totals = totalsForCurrentRequest()
	if (!totals) return roundTrip
	const startedAt = Date.now()
	roundTrip.then(
		(result) => {
			const wallMs = Date.now() - startedAt
			totals.calls += 1
			totals.wallMs += wallMs
			const metas = metaOf(result)
			if (metas.length === 0) return
			totals.reportedCalls += 1
			totals.reportedWallMs += wallMs
			for (const meta of metas) {
				totals.reportedSqlMs += meta.timings?.sql_duration_ms ?? meta.duration
				const servedBy = servedByToken(meta)
				if (servedBy) totals.servedBy.add(servedBy)
			}
		},
		() => {
			totals.calls += 1
			totals.wallMs += Date.now() - startedAt
		},
	)
	return roundTrip
}

function timeStatement(real: D1PreparedStatement): D1PreparedStatement {
	const run =
		(method: 'first' | 'all' | 'run' | 'raw') =>
		(...args: Array<unknown>) =>
			timed(
				(real[method] as (...methodArgs: Array<unknown>) => Promise<unknown>)(
					...args,
				),
			)
	const statement = {
		bind: (...values: Array<unknown>) => timeStatement(real.bind(...values)),
		first: run('first'),
		all: run('all'),
		run: run('run'),
		raw: run('raw'),
	} as unknown as D1PreparedStatement
	realStatements.set(statement, real)
	return statement
}

function timeQueries<Source extends D1Database | D1DatabaseSession>(
	real: Source,
) {
	return {
		prepare: (query: string) => timeStatement(real.prepare(query)),
		batch: (statements: Array<D1PreparedStatement>) =>
			timed(
				real.batch(
					statements.map(
						(statement) => realStatements.get(statement) ?? statement,
					),
				),
			),
	}
}

/** A `D1Database` that forwards to `real` and records each round trip. */
export function timeD1RoundTrips(real: D1Database): D1Database {
	if (timedDatabases.has(real)) return real
	const database = {
		...timeQueries(real),
		exec: (query: string) => timed(real.exec(query)),
		dump: () => real.dump(),
		withSession: (
			constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
		) => {
			const session = real.withSession(constraintOrBookmark)
			return {
				...timeQueries(session),
				getBookmark: () => session.getBookmark(),
			}
		},
	} as unknown as D1Database
	timedDatabases.add(database)
	return database
}

const installedEnvs = new WeakSet<object>()

/**
 * Time `APP_DB` for every request this Worker env serves. Replaces the
 * binding in place, once, so the env object keeps its identity.
 */
export function installD1RoundTripTiming(env: Env | undefined) {
	if (!env || typeof env !== 'object') return
	try {
		if (installedEnvs.has(env)) return
		installedEnvs.add(env)
		if (env.APP_DB) env.APP_DB = timeD1RoundTrips(env.APP_DB)
	} catch (error) {
		console.warn('D1 round trips are not timed:', String(error))
	}
}

/**
 * `d1` is every round trip; `d1-reported` the ones D1 returned `meta` for;
 * `d1-sql` the SQL time D1 reported for those, described by who served them
 * (`WNAM-SJC-primary`). `d1-reported` minus `d1-sql` is time outside SQL.
 */
export function d1RoundTripServerTiming(
	totals: D1RoundTripTotals | undefined,
): Array<ServerTimingEntry> {
	if (!totals || totals.calls === 0) return []
	const entries: Array<ServerTimingEntry> = [
		{ name: 'd1', durationMs: totals.wallMs, desc: `${totals.calls}` },
	]
	if (totals.reportedCalls === 0) return entries
	const servedBy = [...totals.servedBy].sort().join('_')
	entries.push(
		{
			name: 'd1-reported',
			durationMs: totals.reportedWallMs,
			desc: `${totals.reportedCalls}`,
		},
		{
			name: 'd1-sql',
			durationMs: totals.reportedSqlMs,
			...(servedBy ? { desc: servedBy } : {}),
		},
	)
	return entries
}
