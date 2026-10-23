import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'

/**
 * Keeps refresh-token grants for Client ID Metadata Document (CIMD) clients
 * working when the client's metadata host is briefly unreachable.
 *
 * The OAuth provider resolves a CIMD client on every token request. It caches
 * the document only as long as the origin's `Cache-Control` allows, so a
 * `no-store` document (VS Code serves
 * `https://vscode.dev/oauth/client-metadata.json` that way) is fetched live on
 * every refresh. One timeout or 5xx from that host fails the refresh with
 * `invalid_client`, and hosts such as VS Code then drop the session and ask
 * the user to sign in again.
 *
 * Before a refresh-token request reaches the provider, Kody:
 * - leaves an existing provider cache entry alone;
 * - otherwise fetches the document and, when it looks like this client's
 *   document, stores it in the provider's own Cache API entry for at least
 *   {@link cimdRefreshCacheFloorSeconds} (CIMD §5.2 lets the authorization
 *   server set its own lower bound). Once the provider accepts the refresh,
 *   the same document becomes the last known good copy in
 *   `BUNDLE_ARTIFACTS_KV`, so token requests the provider rejects never
 *   write KV;
 * - when the fetch times out, errors, or returns 5xx/429, seeds the provider
 *   cache from the last known good copy (at most
 *   {@link cimdLastKnownGoodTtlSeconds} old, the provider's own maximum CIMD
 *   cache lifetime) and deletes that seed as soon as the provider answers.
 *
 * A 4xx (other than 429) or an invalid document never falls back: the client
 * removed or broke its document, and the provider reports that as before. The
 * provider still validates every cached document before it trusts it. Only
 * the refresh grant primes. Authorization requests and code exchanges never
 * see a last known good copy beyond the refresh that seeded it, though they
 * may reuse a document fetched live in the last five minutes.
 */

/** Cache API name the provider reads CIMD documents from (provider v1.2). */
export const providerCimdCacheName = 'workers-oauth-provider:cimd:v1'

/**
 * Minimum provider cache lifetime for a document Kody just fetched live. Like
 * the provider's own caching of a cacheable document, authorize and code
 * exchange in the same location may reuse it within this window.
 */
const cimdRefreshCacheFloorSeconds = 5 * 60

/**
 * Lifetime of a last known good seed. `settle` deletes it as soon as the
 * provider answers, so it only outlives its refresh if that delete fails.
 */
const cimdFallbackCacheSeconds = 60

/** Last known good lifetime: the provider's CIMD cache cap (7 days). */
const cimdLastKnownGoodTtlSeconds = 7 * 24 * 60 * 60

/** Rewrite an unchanged last known good copy at most once a day. */
const lastKnownGoodRewriteAfterMs = 24 * 60 * 60 * 1000

/** Shorter than the provider's 10s fetch timeout so a fallback still fits. */
const cimdPrimeFetchTimeoutMs = 5_000

/** Provider limit for a CIMD document body. */
const cimdMaxDocumentBytes = 5 * 1024

const lastKnownGoodKeyPrefix = `${derivedCacheKeyPrefix}oauth-cimd-last-known-good:`

type CimdRefreshPrimeOutcome =
	| 'not-cimd'
	| 'cache-unavailable'
	| 'cached'
	| 'fetched'
	| 'fallback'
	| 'unavailable'
	| 'rejected'

type LastKnownGood = {
	document: string
	storedAt: number
}

/**
 * URL-shaped client ids the provider resolves through CIMD (HTTPS with a
 * path). The provider runs its own stricter validation on every lookup; this
 * only decides whether priming applies.
 */
export function isCimdClientIdUrl(clientId: string) {
	try {
		const url = new URL(clientId)
		return (
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			!url.hash &&
			url.pathname !== '/' &&
			url.pathname !== ''
		)
	} catch {
		return false
	}
}

export async function cimdLastKnownGoodKey(clientId: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(clientId),
	)
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return `${lastKnownGoodKeyPrefix}${hex}`
}

function isTransientStatus(status: number) {
	return status === 429 || status >= 500
}

function originCacheTtlSeconds(response: Response) {
	const cacheControl = response.headers.get('Cache-Control')
	if (
		!cacheControl ||
		/(?:^|,)\s*(?:no-cache|no-store|private)\b/i.test(cacheControl)
	) {
		return 0
	}
	const directive =
		/(?:^|,)\s*s-maxage\s*=\s*"?(\d+)/i.exec(cacheControl) ??
		/(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cacheControl)
	return directive ? Number(directive[1]) : 0
}

/** The body, or null (stream cancelled) once it grows past `maxBytes`. */
async function readBoundedBytes(response: Response, maxBytes: number) {
	const reader = response.body?.getReader()
	if (!reader) return null
	const chunks: Array<Uint8Array> = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxBytes) {
			await reader.cancel().catch(() => {})
			return null
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

/** The document text when it is small JSON naming this client, else null. */
async function readClientDocument(response: Response, clientId: string) {
	const declaredLength = Number(response.headers.get('Content-Length'))
	if (Number.isFinite(declaredLength) && declaredLength > cimdMaxDocumentBytes)
		return null
	const bytes = await readBoundedBytes(response, cimdMaxDocumentBytes)
	if (!bytes || bytes.byteLength === 0) return null
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		const value = JSON.parse(text) as unknown
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			(value as { client_id?: unknown }).client_id !== clientId
		) {
			return null
		}
		return text
	} catch {
		return null
	}
}

async function seedProviderCache(
	cache: Cache,
	clientId: string,
	document: string,
	ttlSeconds: number,
) {
	try {
		await cache.put(
			clientId,
			new Response(document, {
				status: 200,
				headers: {
					'Cache-Control': `public, max-age=${ttlSeconds}`,
					'Content-Type': 'application/json',
				},
			}),
		)
		return true
	} catch {
		return false
	}
}

async function readLastKnownGood(env: Env, key: string) {
	try {
		const stored = await env.BUNDLE_ARTIFACTS_KV.get<LastKnownGood>(key, 'json')
		if (
			!stored ||
			typeof stored.document !== 'string' ||
			typeof stored.storedAt !== 'number'
		) {
			return null
		}
		return stored
	} catch {
		return null
	}
}

async function rememberLastKnownGood(input: {
	env: Env
	key: string
	document: string
	now: number
}) {
	const existing = await readLastKnownGood(input.env, input.key)
	if (
		existing?.document === input.document &&
		input.now - existing.storedAt < lastKnownGoodRewriteAfterMs
	) {
		return
	}
	try {
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			input.key,
			JSON.stringify({
				document: input.document,
				storedAt: input.now,
			} satisfies LastKnownGood),
			{ expirationTtl: cimdLastKnownGoodTtlSeconds },
		)
	} catch (error) {
		console.warn('oauth-cimd-last-known-good-write-failed', error)
	}
}

async function fallBackToLastKnownGood(input: {
	env: Env
	cache: Cache
	clientId: string
	key: string
	now: number
	cause: string
}): Promise<CimdRefreshPrimeOutcome> {
	const stored = await readLastKnownGood(input.env, input.key)
	const fresh =
		stored !== null &&
		input.now - stored.storedAt < cimdLastKnownGoodTtlSeconds * 1000
	const seeded =
		fresh &&
		(await seedProviderCache(
			input.cache,
			input.clientId,
			stored.document,
			cimdFallbackCacheSeconds,
		))
	console.warn(
		'oauth-cimd-refresh-fallback',
		JSON.stringify({
			clientId: input.clientId,
			cause: input.cause,
			usedLastKnownGood: seeded,
		}),
	)
	return seeded ? 'fallback' : 'unavailable'
}

type CimdRefreshPreparation = {
	outcome: CimdRefreshPrimeOutcome
	/**
	 * Call once the provider answered. Removes a last known good seed so only
	 * this refresh used it, and records a freshly fetched document as last
	 * known good only when the provider accepted the refresh (an anonymous
	 * token request with an arbitrary client URL never writes KV).
	 */
	settle: (providerAccepted: boolean) => Promise<void>
}

const settled = async () => {}

/**
 * Make sure the provider can resolve this CIMD client for a refresh grant.
 * Never throws: every failure leaves the provider's normal lookup in charge.
 */
export async function prepareCimdClientForRefresh(input: {
	env: Env
	clientId: string | null
	now?: number
}): Promise<CimdRefreshPreparation> {
	const clientId = input.clientId
	if (!clientId || !isCimdClientIdUrl(clientId)) {
		return { outcome: 'not-cimd', settle: settled }
	}
	if (typeof caches === 'undefined') {
		return { outcome: 'cache-unavailable', settle: settled }
	}
	let cache: Cache
	try {
		cache = await caches.open(providerCimdCacheName)
		if (await cache.match(clientId)) {
			return { outcome: 'cached', settle: settled }
		}
	} catch {
		return { outcome: 'cache-unavailable', settle: settled }
	}
	const now = input.now ?? Date.now()
	const key = await cimdLastKnownGoodKey(clientId)
	const fallBack = async (cause: string): Promise<CimdRefreshPreparation> => {
		const outcome = await fallBackToLastKnownGood({
			env: input.env,
			cache,
			clientId,
			key,
			now,
			cause,
		})
		if (outcome !== 'fallback') return { outcome, settle: settled }
		return {
			outcome,
			settle: async () => {
				await cache.delete(clientId).catch(() => false)
			},
		}
	}
	let response: Response
	try {
		response = await fetch(clientId, {
			headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
			cache: 'no-store',
			signal: AbortSignal.timeout(cimdPrimeFetchTimeoutMs),
		})
	} catch (error) {
		return fallBack(
			error instanceof Error && error.name === 'TimeoutError'
				? 'timeout'
				: 'network_error',
		)
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {})
		if (!isTransientStatus(response.status)) {
			return { outcome: 'rejected', settle: settled }
		}
		return fallBack(`http_${response.status}`)
	}
	let document: string | null
	try {
		document = await readClientDocument(response, clientId)
	} catch {
		return fallBack('body_read_failed')
	}
	if (!document) return { outcome: 'rejected', settle: settled }
	const liveDocument = document
	const ttlSeconds = Math.min(
		Math.max(originCacheTtlSeconds(response), cimdRefreshCacheFloorSeconds),
		cimdLastKnownGoodTtlSeconds,
	)
	await seedProviderCache(cache, clientId, liveDocument, ttlSeconds)
	return {
		outcome: 'fetched',
		settle: async (providerAccepted) => {
			if (!providerAccepted) return
			await rememberLastKnownGood({
				env: input.env,
				key,
				document: liveDocument,
				now,
			})
		},
	}
}
