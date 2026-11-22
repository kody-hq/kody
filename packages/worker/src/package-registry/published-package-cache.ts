type PublishedPackageCacheSource = {
	id: string
	published_commit: string | null
	manifest_path: string
	source_root: string
}

export const publishedPackageCacheLimit = 50
export const publishedPackageCacheTtlMs = 5 * 60 * 1000

export function createPublishedPackageCacheKey(input: {
	userId: string
	source: PublishedPackageCacheSource
	entryPoint?: string | null
}) {
	if (!input.source.published_commit) {
		return null
	}

	return JSON.stringify([
		input.userId,
		input.source.id,
		input.source.published_commit,
		input.source.manifest_path,
		input.source.source_root,
		input.entryPoint?.trim() || null,
	])
}

/**
 * How long a request waits on another request's in-flight entry before it
 * starts its own `create()`. A Workers isolate serves many requests, and a
 * promise created by one request never settles once that request ends or is
 * canceled (for example when its client disconnects). Awaiting it either
 * hangs the waiter ("error code: 1101") or, with the runtime's
 * `handle_cross_request_promise_resolution` behavior, rejects it with "This
 * promise was created by a request that has since ended". The timer covers
 * the hang; a rejection makes the waiter rebuild in its own request.
 */
export const promiseLruCacheInFlightWaitMs = 5_000

type PromiseLruCacheEntry<T> = {
	expiresAt: number
	pending: Promise<T>
	/** Set once `pending` resolves; hits are served from it, not `pending`. */
	settled: { value: T } | null
	bytes: number
	lastUsed: number
}

/**
 * Approximate bytes a cached value keeps alive: string lengths plus binary
 * byte lengths, walked through plain objects and arrays. Class instances
 * (bindings, stubs) and functions are skipped; they are not ours to size.
 */
export function estimateRetainedBytes(value: unknown): number {
	const seen = new Set<object>()
	const stack: Array<unknown> = [value]
	let bytes = 0
	while (stack.length > 0) {
		const next = stack.pop()
		if (typeof next === 'string') {
			bytes += next.length
			continue
		}
		if (next === null || typeof next !== 'object' || seen.has(next)) {
			continue
		}
		seen.add(next)
		if (ArrayBuffer.isView(next) || next instanceof ArrayBuffer) {
			bytes += next.byteLength
			continue
		}
		if (Array.isArray(next)) {
			stack.push(...next)
			continue
		}
		const prototype = Object.getPrototypeOf(next)
		if (prototype !== Object.prototype && prototype !== null) {
			continue
		}
		for (const [key, child] of Object.entries(next)) {
			bytes += key.length
			stack.push(child)
		}
	}
	return bytes
}

/**
 * One retained-byte budget shared by every cache that holds whole package
 * sources, bundles, or artifacts. Entry counts alone do not bound memory:
 * one published package source can be several MiB, so 50 entries per cache
 * across several caches could hold more than the isolate's memory limit.
 * When the shared total goes over budget, the least recently used settled
 * entry across all registered caches is evicted first.
 */
type SizedEntryCache = {
	oldestSizedEntry(): { key: string; lastUsed: number } | null
	delete(key: string): void
}

export class RetainedByteBudget {
	constructor(maxBytes: number) {
		this.maxBytes = maxBytes
	}

	readonly maxBytes: number

	private readonly caches = new Set<SizedEntryCache>()
	private usedBytes = 0
	private clock = 0

	get retainedBytes() {
		return this.usedBytes
	}

	/** @internal */
	tick() {
		this.clock += 1
		return this.clock
	}

	/** @internal */
	register(cache: SizedEntryCache) {
		this.caches.add(cache)
	}

	/** @internal */
	adjust(delta: number) {
		this.usedBytes += delta
	}

	/** @internal */
	enforce() {
		while (this.usedBytes > this.maxBytes) {
			let oldest: { cache: SizedEntryCache; key: string } | null = null
			let oldestUsed = Number.POSITIVE_INFINITY
			for (const cache of this.caches) {
				const candidate = cache.oldestSizedEntry()
				if (candidate && candidate.lastUsed < oldestUsed) {
					oldestUsed = candidate.lastUsed
					oldest = { cache, key: candidate.key }
				}
			}
			if (!oldest) {
				break
			}
			oldest.cache.delete(oldest.key)
		}
	}
}

/**
 * Isolate-wide budget for caches of whole package sources, runtime bundles,
 * and published artifacts. A Workers isolate has 128 MiB for everything; this
 * keeps reuse for hot packages while leaving most of it to live requests.
 */
export const packageArtifactCacheMaxBytes = 24 * 1024 * 1024
export const packageArtifactCacheBudget = new RetainedByteBudget(
	packageArtifactCacheMaxBytes,
)

export class PromiseLruCache<T> {
	private readonly cache = new Map<string, PromiseLruCacheEntry<T>>()

	constructor(input?: {
		ttlMs?: number
		limit?: number
		inFlightWaitMs?: number
		/**
		 * Bound retained bytes, not just entries. Settled values are sized with
		 * `sizeOf` (default {@link estimateRetainedBytes}); a value bigger than
		 * the whole budget is returned to its caller but never cached.
		 */
		byteBudget?: RetainedByteBudget
		sizeOf?: (value: T) => number
		/**
		 * `false` shares only in-flight work: an entry is dropped once it
		 * settles, so every later call runs its own `create()`.
		 */
		retainSettled?: boolean
	}) {
		this.ttlMs = input?.ttlMs ?? publishedPackageCacheTtlMs
		this.limit = input?.limit ?? publishedPackageCacheLimit
		this.inFlightWaitMs = input?.inFlightWaitMs ?? promiseLruCacheInFlightWaitMs
		this.byteBudget = input?.byteBudget ?? null
		this.sizeOf = input?.sizeOf ?? estimateRetainedBytes
		this.retainSettled = input?.retainSettled ?? true
		this.byteBudget?.register(this)
	}

	private readonly ttlMs: number
	private readonly limit: number
	private readonly inFlightWaitMs: number
	private readonly byteBudget: RetainedByteBudget | null
	private readonly sizeOf: (value: T) => number
	private readonly retainSettled: boolean

	/** @internal Least recently used settled entry that holds sized bytes. */
	oldestSizedEntry() {
		for (const [key, entry] of this.cache) {
			if (entry.bytes > 0) {
				return { key, lastUsed: entry.lastUsed }
			}
		}
		return null
	}

	private touch(entry: PromiseLruCacheEntry<T>) {
		if (this.byteBudget) {
			entry.lastUsed = this.byteBudget.tick()
		}
	}

	private getEntry(key: string) {
		const cached = this.cache.get(key)
		if (!cached) {
			return null
		}
		if (cached.expiresAt <= Date.now()) {
			this.delete(key)
			return null
		}
		this.cache.delete(key)
		this.cache.set(key, cached)
		this.touch(cached)
		return cached
	}

	/**
	 * A settled value, as a promise owned by the caller's request. Never
	 * another request's in-flight promise: use `getOrCreate` to wait on one.
	 */
	get(key: string) {
		const settled = this.getEntry(key)?.settled
		return settled ? Promise.resolve(settled.value) : null
	}

	set(key: string, pending: Promise<T>) {
		const entry: PromiseLruCacheEntry<T> = {
			expiresAt: Date.now() + this.ttlMs,
			pending,
			settled: null,
			bytes: 0,
			lastUsed: 0,
		}
		this.delete(key)
		this.cache.set(key, entry)
		this.touch(entry)
		void pending.then(
			(value) => {
				if (!this.retainSettled) {
					if (this.cache.get(key) === entry) this.delete(key)
					return
				}
				entry.settled = { value }
				this.recordSize(key, entry, value)
			},
			() => {},
		)
		this.enforceLimit()
		return pending
	}

	getOrCreate(input: { cacheKey: string; create: () => Promise<T> }) {
		const cached = this.getEntry(input.cacheKey)
		if (cached?.settled) {
			return Promise.resolve(cached.settled.value)
		}
		if (cached) {
			return this.waitForInFlight(cached, input, { retried: false })
		}
		return this.createEntry(input)
	}

	delete(key: string) {
		const entry = this.cache.get(key)
		if (!entry) {
			return
		}
		this.cache.delete(key)
		if (entry.bytes > 0) {
			this.byteBudget?.adjust(-entry.bytes)
			entry.bytes = 0
		}
	}

	/** Drop every entry whose key matches, e.g. one owner's prefix. */
	deleteWhere(matches: (key: string) => boolean) {
		for (const key of [...this.cache.keys()]) {
			if (matches(key)) this.delete(key)
		}
	}

	clear() {
		this.deleteWhere(() => true)
	}

	private recordSize(key: string, entry: PromiseLruCacheEntry<T>, value: T) {
		const budget = this.byteBudget
		if (!budget || this.cache.get(key) !== entry) {
			return
		}
		const bytes = Math.max(1, this.sizeOf(value))
		if (bytes > budget.maxBytes) {
			this.delete(key)
			return
		}
		entry.bytes = bytes
		budget.adjust(bytes)
		budget.enforce()
	}

	private createEntry(input: { cacheKey: string; create: () => Promise<T> }) {
		let pending: Promise<T>
		pending = input.create().catch((error) => {
			if (this.cache.get(input.cacheKey)?.pending === pending) {
				this.delete(input.cacheKey)
			}
			throw error
		})
		this.set(input.cacheKey, pending)
		return pending
	}

	/**
	 * Await an entry another request may own. If it has not settled within
	 * `inFlightWaitMs`, or it rejects, treat it as orphaned: replace it (when
	 * it is still the cached entry) and run `create()` in this request. The
	 * owner may have ended, and its failure is not this request's. A waiter
	 * shares at most one other rebuild; if that one also fails or stalls, it
	 * runs its own `create()`, so the only rejection a caller sees is one
	 * from a `create()` it ran.
	 */
	private waitForInFlight(
		entry: PromiseLruCacheEntry<T>,
		input: { cacheKey: string; create: () => Promise<T> },
		options: { retried: boolean },
	) {
		return new Promise<T>((resolve, reject) => {
			let done = false
			const takeOver = () => {
				if (this.cache.get(input.cacheKey) === entry) {
					this.delete(input.cacheKey)
				}
				// Another waiter may already have started a rebuild: share it
				// instead of replacing it with a second create().
				const current = this.getEntry(input.cacheKey)
				const next = current?.settled
					? Promise.resolve(current.settled.value)
					: !current || options.retried
						? this.createEntry(input)
						: this.waitForInFlight(current, input, { retried: true })
				next.then(resolve, reject)
			}
			const timer = setTimeout(() => {
				if (done) return
				done = true
				takeOver()
			}, this.inFlightWaitMs)
			entry.pending.then(
				(value) => {
					if (done) return
					done = true
					clearTimeout(timer)
					resolve(value)
				},
				() => {
					if (done) return
					done = true
					clearTimeout(timer)
					takeOver()
				},
			)
		})
	}

	private enforceLimit() {
		while (this.cache.size > this.limit) {
			const oldestKey = this.cache.keys().next().value
			if (oldestKey === undefined) {
				break
			}
			this.delete(oldestKey)
		}
	}
}

/**
 * One {@link PromiseLruCache} per binding object (a `D1Database`, an `env`),
 * so test databases never share entries and a dropped binding frees its cache.
 */
export function createPromiseLruCacheByBinding<T>(
	options?: ConstructorParameters<typeof PromiseLruCache<T>>[0],
) {
	const caches = new WeakMap<object, PromiseLruCache<T>>()
	return {
		for(binding: object) {
			let cache = caches.get(binding)
			if (!cache) {
				cache = new PromiseLruCache<T>(options)
				caches.set(binding, cache)
			}
			return cache
		},
		clear(binding: object) {
			caches.get(binding)?.clear()
		},
	}
}

export function createPublishedPackagePromiseCache<T>() {
	return new PromiseLruCache<T>({ byteBudget: packageArtifactCacheBudget })
}
