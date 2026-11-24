import { AsyncLocalStorage } from 'node:async_hooks'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'
import type { D1RoundTripTotals } from '#worker/d1-round-trip-timing.ts'

/**
 * Per-request scratch space shared by every loader that runs for one HTTP
 * request: a memo for expensive lookups the page needs more than once (the
 * handler and the SSR frame both resolve the same package), and the
 * Server-Timing entries recorded along the way.
 *
 * The context travels two ways. `AsyncLocalStorage` propagates it through the
 * awaits between `handleRequest` and code that has no `Request` in hand (the
 * repo layer). SSR frames render while the response body streams, which can
 * be after the storage scope has exited, so the same context is also keyed by
 * `Request` and callers that hold the request pass it explicitly.
 */
export type RequestContext = {
	request: Request
	serverTiming: Array<ServerTimingEntry>
	memo: Map<string, Promise<unknown>>
	/** Filled by `d1-round-trip-timing.ts` as the request reads D1. */
	d1?: D1RoundTripTotals
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>()
const requestContexts = new WeakMap<Request, RequestContext>()

function ensureRequestContext(request: Request): RequestContext {
	let context = requestContexts.get(request)
	if (!context) {
		context = { request, serverTiming: [], memo: new Map() }
		requestContexts.set(request, context)
	}
	return context
}

export function runWithRequestContext<Result>(
	request: Request,
	run: () => Result,
): Result {
	return requestContextStorage.run(ensureRequestContext(request), run)
}

/**
 * The active request context, if any. An explicit `request` wins over the
 * async-local store so streaming SSR frames find the page's context.
 */
export function getRequestContext(
	request?: Request,
): RequestContext | undefined {
	if (request) {
		const byRequest = requestContexts.get(request)
		if (byRequest) return byRequest
	}
	return requestContextStorage.getStore()
}

/**
 * Run `load` once per request for `key` and hand every later caller the same
 * promise. Without a request context (tests, jobs) it just loads. A rejected
 * load is forgotten so a retry within the request can try again.
 */
export function memoizePerRequest<Value>(input: {
	request?: Request
	key: string
	load: () => Promise<Value>
	/** Reload instead of reusing a settled value this rejects. */
	isFresh?: (value: Value) => boolean
}): Promise<Value> {
	const { isFresh } = input
	const load = isFresh
		? () =>
				input.load().then((value) => (isFresh(value) ? value : input.load()))
		: input.load
	const context = getRequestContext(input.request)
	if (!context) return load()
	const pending = context.memo.get(input.key) as Promise<Value> | undefined
	if (pending) {
		if (!isFresh) return pending
		return pending.then((value) =>
			isFresh(value) ? value : reloadMemo(context.memo, input.key, load),
		)
	}
	return reloadMemo(context.memo, input.key, load)
}

/**
 * {@link memoizePerRequest} for identity, organization, and flag rows that
 * every layer of a page re-reads (shell, session check, page auth, handler).
 * Only GET and HEAD requests share the read: a request that may write those
 * rows always reads them live, so it can never act on its own stale value.
 */
export function memoizeReadPerRequest<Value>(input: {
	key: string
	load: () => Promise<Value>
}): Promise<Value> {
	const method = getRequestContext()?.request.method
	if (method !== 'GET' && method !== 'HEAD') return input.load()
	return memoizePerRequest(input)
}

function reloadMemo<Value>(
	memo: Map<string, Promise<unknown>>,
	key: string,
	load: () => Promise<Value>,
): Promise<Value> {
	const loading = load()
	memo.set(key, loading)
	loading.catch(() => {
		if (memo.get(key) === loading) memo.delete(key)
	})
	return loading
}

/**
 * Time `run` and record it on the request's Server-Timing entries. Outside a
 * request context this is a plain call.
 */
export function recordServerTiming<Value>(
	name: string,
	run: () => Promise<Value>,
	request?: Request,
): Promise<Value> {
	return pushServerTiming(getRequestContext(request)?.serverTiming, name, run)
}

/**
 * Entries recorded on the request context merged with entries a handler
 * collected in its own array, for the response header.
 */
export function collectServerTiming(
	request: Request,
	own?: Array<ServerTimingEntry>,
): Array<ServerTimingEntry> {
	const recorded = getRequestContext(request)?.serverTiming ?? []
	if (!own || own === recorded) return recorded
	return [...recorded, ...own]
}
