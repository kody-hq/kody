import { cachified, createCacheEntry } from '@epic-web/cachified'
import { deferWork } from '#worker/deferred-work.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import {
	memoizePerRequest,
	recordServerTiming,
} from '#worker/request-context.ts'
import {
	getArtifactsNamespace,
	resolveArtifactSourceHead,
} from './artifacts.ts'

/**
 * Default-branch HEAD of an Artifacts repo, as the package pages read it.
 *
 * Resolving it live costs three sequential network hops (binding `get`, REST
 * repo info + token mint, then git `info/refs`) and was the single largest
 * cost on every package home, tree, and file view. HEAD only moves on push,
 * and pushes reach the worker as `cf.artifacts.repo.pushed` queue events, so
 * the value is cached in KV and corrected on push. The TTL bounds staleness for
 * a missed event without touching repos nobody is looking at: only a page view
 * fills the cache, and only a push to a cached repo rewrites it.
 */
export type ArtifactSourceHead = {
	branch: string
	commit: string | null
}

const headTtlMs = 5 * 60_000
const headStaleWhileRevalidateMs = 60 * 60_000
/** A repo without a resolvable HEAD is usually mid-bootstrap; recheck soon. */
const missingHeadTtlMs = 60_000
const deletedRefCommit = /^0+$/

export function isDeletedArtifactRefCommit(commit: string) {
	return deletedRefCommit.test(commit)
}

export function isArtifactSourceHead(
	value: unknown,
): value is ArtifactSourceHead {
	if (typeof value !== 'object' || value === null) return false
	const head = value as Record<string, unknown>
	return (
		typeof head.branch === 'string' &&
		head.branch.length > 0 &&
		(head.commit === null || typeof head.commit === 'string')
	)
}

export function buildArtifactSourceHeadCacheKey(env: Env, repoId: string) {
	return `artifact-head:v1:${getArtifactsNamespace(env)}:${repoId}`
}

function readHeadCacheKv(env: Env): KVNamespace | null {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV ?? null
	)
}

async function loadArtifactSourceHead(input: {
	env: Env
	repoId: string
}): Promise<ArtifactSourceHead> {
	const kv = readHeadCacheKv(input.env)
	if (!kv) return resolveArtifactSourceHead(input.env, input.repoId)
	return cachified({
		key: buildArtifactSourceHeadCacheKey(input.env, input.repoId),
		cache: createKvCachifiedCache(kv),
		ttl: headTtlMs,
		staleWhileRevalidate: headStaleWhileRevalidateMs,
		checkValue: isArtifactSourceHead,
		async getFreshValue(context) {
			const head = await resolveArtifactSourceHead(input.env, input.repoId)
			if (!head.commit) {
				context.metadata.ttl = missingHeadTtlMs
				context.metadata.swr = 0
			}
			return head
		},
		waitUntil(promise) {
			void deferWork('artifact-head-cache-refresh', () => promise)
		},
	})
}

/**
 * Cached HEAD for `repoId`, resolved at most once per request. Falls back to
 * the live lookup when the KV binding is absent (unit tests, minimal envs).
 * Callers that must see the live value use `resolveArtifactSourceHead`
 * directly rather than a bypass flag here: the request memo would otherwise
 * hand a "fresh" caller the cached promise from an earlier lookup.
 */
export function resolveCachedArtifactSourceHead(
	env: Env,
	repoId: string,
	options?: { request?: Request },
): Promise<ArtifactSourceHead> {
	return memoizePerRequest({
		request: options?.request,
		key: `artifact-head:${repoId}`,
		load: () =>
			recordServerTiming(
				'artifacts-head',
				() => loadArtifactSourceHead({ env, repoId }),
				options?.request,
			),
	})
}

const freshHeadTimeoutMs = 3_000

function writeArtifactSourceHead(
	env: Env,
	repoId: string,
	head: ArtifactSourceHead,
) {
	const kv = readHeadCacheKv(env)
	if (!kv) return Promise.resolve()
	return createKvCachifiedCache(kv).set(
		buildArtifactSourceHeadCacheKey(env, repoId),
		createCacheEntry(
			head,
			head.commit
				? { ttl: headTtlMs, swr: headStaleWhileRevalidateMs }
				: { ttl: missingHeadTtlMs, swr: 0 },
		),
	)
}

async function readCachedArtifactSourceHead(env: Env, repoId: string) {
	const kv = readHeadCacheKv(env)
	if (!kv) return null
	const entry = await createKvCachifiedCache(kv).get(
		buildArtifactSourceHeadCacheKey(env, repoId),
	)
	return entry && isArtifactSourceHead(entry.value) ? entry.value : null
}

/**
 * Live HEAD for `repoId`, written back to the cache. Owner Settings must see a
 * push the moment it lands (#4981): a cached HEAD can lag an external git push
 * for the whole TTL when the push event misses the cache (nobody had viewed
 * the repo) or arrives late. When the live lookup fails or outlasts
 * `timeoutMs`, the last cached HEAD is returned and a slow lookup still
 * refreshes the cache in the background.
 */
export async function resolveFreshArtifactSourceHead(
	env: Env,
	repoId: string,
	options?: { timeoutMs?: number },
): Promise<ArtifactSourceHead> {
	const live = resolveArtifactSourceHead(env, repoId).then(async (head) => {
		await writeArtifactSourceHead(env, repoId, head)
		return head
	})
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(
			() => resolve('timeout'),
			options?.timeoutMs ?? freshHeadTimeoutMs,
		)
	})
	try {
		const result = await Promise.race([live, timedOut])
		if (result !== 'timeout') return result
		void deferWork('artifact-head-fresh-refresh', () => live)
	} catch (error) {
		const cached = await readCachedArtifactSourceHead(env, repoId)
		if (cached) return cached
		throw error
	} finally {
		clearTimeout(timer)
	}
	const cached = await readCachedArtifactSourceHead(env, repoId)
	return cached ?? (await live)
}

/**
 * Apply a push to the cached HEAD. A push to the cached default branch
 * rewrites the commit in place from the event payload — no Artifacts call —
 * a push to another branch leaves HEAD alone, and a repo nobody has viewed
 * has no entry to maintain.
 */
/**
 * Last known default-branch name from the KV head cache. Live
 * `resolveArtifactSourceHead` is the source of truth; this is only a
 * fallback when that lookup throws. The cached commit may already be the
 * push under test (`applyArtifactSourcePushToHeadCache` writes it), so
 * callers must not treat this as proof of the live tip.
 */
export async function readCachedArtifactSourceBranch(
	env: Env,
	repoId: string,
): Promise<string | null> {
	const kv = readHeadCacheKv(env)
	if (!kv) return null
	const cache = createKvCachifiedCache(kv)
	const entry = await cache.get(buildArtifactSourceHeadCacheKey(env, repoId))
	if (!entry || !isArtifactSourceHead(entry.value)) return null
	const branch = entry.value.branch.trim()
	return branch.length > 0 ? branch : null
}

export async function applyArtifactSourcePushToHeadCache(input: {
	env: Env
	repoId: string
	ref: string
	after: string
}) {
	const kv = readHeadCacheKv(input.env)
	if (!kv) return
	const cache = createKvCachifiedCache(kv)
	const key = buildArtifactSourceHeadCacheKey(input.env, input.repoId)
	const entry = await cache.get(key)
	if (!entry) return
	const branchRef = isArtifactSourceHead(entry.value)
		? `refs/heads/${entry.value.branch}`
		: null
	if (branchRef && input.ref !== branchRef) return
	if (
		branchRef &&
		isArtifactSourceHead(entry.value) &&
		!isDeletedArtifactRefCommit(input.after)
	) {
		await cache.set(
			key,
			createCacheEntry(
				{ branch: entry.value.branch, commit: input.after },
				{ ttl: headTtlMs, swr: headStaleWhileRevalidateMs },
			),
		)
		return
	}
	await cache.delete(key)
}
