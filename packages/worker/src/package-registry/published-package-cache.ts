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
 * canceled (for example when its client disconnects). A request that awaits
 * such a promise has no I/O of its own, so the runtime cancels it as hung
 * ("error code: 1101"). The timer keeps the waiter alive and lets it recover.
 */
export const promiseLruCacheInFlightWaitMs = 5_000

type PromiseLruCacheEntry<T> = {
	expiresAt: number
	pending: Promise<T>
	settled: boolean
}

export class PromiseLruCache<T> {
	private readonly cache = new Map<string, PromiseLruCacheEntry<T>>()

	constructor(input?: {
		ttlMs?: number
		limit?: number
		inFlightWaitMs?: number
	}) {
		this.ttlMs = input?.ttlMs ?? publishedPackageCacheTtlMs
		this.limit = input?.limit ?? publishedPackageCacheLimit
		this.inFlightWaitMs = input?.inFlightWaitMs ?? promiseLruCacheInFlightWaitMs
	}

	private readonly ttlMs: number
	private readonly limit: number
	private readonly inFlightWaitMs: number

	private getEntry(key: string) {
		const cached = this.cache.get(key)
		if (!cached) {
			return null
		}
		if (cached.expiresAt <= Date.now()) {
			this.cache.delete(key)
			return null
		}
		this.cache.delete(key)
		this.cache.set(key, cached)
		return cached
	}

	get(key: string) {
		return this.getEntry(key)?.pending ?? null
	}

	set(key: string, pending: Promise<T>) {
		const entry: PromiseLruCacheEntry<T> = {
			expiresAt: Date.now() + this.ttlMs,
			pending,
			settled: false,
		}
		this.cache.set(key, entry)
		void pending.then(
			() => {
				entry.settled = true
			},
			() => {},
		)
		this.enforceLimit()
		return pending
	}

	getOrCreate(input: { cacheKey: string; create: () => Promise<T> }) {
		const cached = this.getEntry(input.cacheKey)
		if (cached?.settled) {
			return cached.pending
		}
		if (cached) {
			return this.waitForInFlight(cached, input)
		}
		return this.createEntry(input)
	}

	delete(key: string) {
		this.cache.delete(key)
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
	 * `inFlightWaitMs`, treat it as orphaned: replace it (when it is still the
	 * cached entry) and run `create()` in this request.
	 */
	private waitForInFlight(
		entry: PromiseLruCacheEntry<T>,
		input: { cacheKey: string; create: () => Promise<T> },
	) {
		return new Promise<T>((resolve, reject) => {
			let done = false
			const timer = setTimeout(() => {
				if (done) return
				done = true
				if (this.cache.get(input.cacheKey) === entry) {
					this.delete(input.cacheKey)
				}
				const current = this.getEntry(input.cacheKey)
				const next = current?.settled
					? current.pending
					: this.createEntry(input)
				next.then(resolve, reject)
			}, this.inFlightWaitMs)
			entry.pending.then(
				(value) => {
					if (done) return
					done = true
					clearTimeout(timer)
					resolve(value)
				},
				(error: unknown) => {
					if (done) return
					done = true
					clearTimeout(timer)
					reject(error)
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
			this.cache.delete(oldestKey)
		}
	}
}

export function createPublishedPackagePromiseCache<T>() {
	return new PromiseLruCache<T>()
}
