import {
	builtInFallbackCimdDocument,
	isWorkerBlockedCimdHost,
	normalizeCimdClientId,
} from '#worker/oauth-known-cimd-clients.ts'

/**
 * Last known good Client ID Metadata Documents (CIMD), for every client
 * lookup: authorize page load, approve, code exchange, and refresh.
 *
 * The OAuth provider resolves a CIMD client live on every lookup and caches
 * it only as long as the origin's `Cache-Control` allows (`no-store` for VS
 * Code, five minutes for chatgpt.com). Any fetch failure used to fail the
 * flow: "Unknown OAuth client" on authorize, `invalid_client` on refresh.
 *
 * Kody patches the provider (patches/@cloudflare+workers-oauth-provider+*)
 * with two hooks, wired in `oauth-provider-options.ts`:
 * - `onClientIdMetadataDocumentResolved` hands every document that validated
 *   to {@link noteResolvedCimdDocument}, an in-isolate stash. Nothing is
 *   written yet, so anonymous lookups of arbitrary client URLs never write KV.
 *   {@link rememberCimdLastKnownGood} writes the stashed document to
 *   `BUNDLE_ARTIFACTS_KV` only after a flow succeeds (a token response or an
 *   approved authorization), at most daily while unchanged, for
 *   {@link cimdLastKnownGoodTtlSeconds}.
 * - `clientIdMetadataDocumentFallback` calls {@link recallCimdLastKnownGood}
 *   when the live fetch fails. The provider validates whatever it returns
 *   exactly like a fetched document.
 *
 * Fallback policy (see {@link cimdFallbackDecision}):
 * - timeout, network error, 5xx, 429: any CIMD host (an outage);
 * - 401, 403, 404 only for hosts known to refuse Worker fetches
 *   (`isWorkerBlockedCimdHost`, today chatgpt.com). Elsewhere a 4xx means
 *   the publisher withdrew or moved the document, which must take effect;
 * - 410, other 4xx, and an invalid document: never.
 *
 * A fallback copy is never re-stored, so its age only grows: a document that
 * has been unreachable for 14 days stops resolving.
 */

/** Last known good lifetime: 14 days. */
export const cimdLastKnownGoodTtlSeconds = 14 * 24 * 60 * 60

/** Rewrite an unchanged last known good copy at most once a day. */
const lastKnownGoodRewriteAfterMs = 24 * 60 * 60 * 1000

/** Stash lifetime and size: long enough to span authorize to token exchange. */
const resolvedStashTtlMs = 15 * 60 * 1000
const resolvedStashMaxEntries = 200

/** Provider limit for a CIMD document body. */
const cimdMaxDocumentBytes = 5 * 1024

/**
 * Under `derivedCacheKeyPrefix` (kv-cachified.ts), spelled out so this module
 * stays off the cachified import graph (it loads with the provider options).
 */
const lastKnownGoodKeyPrefix = 'derived-cache:v1:oauth-cimd-last-known-good:'

type LastKnownGood = {
	document: string
	storedAt: number
}

/**
 * URL-shaped client ids the provider resolves through CIMD (HTTPS with a
 * path). The provider runs its own stricter validation on every lookup.
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

export type CimdFetchFailure =
	| { type: 'http'; status: number }
	| { type: 'timeout' }
	| { type: 'network_error' }
	| { type: 'invalid_document' }

/** `http_404`, `timeout`, `network_error`, or `invalid_document`. */
export function cimdFetchFailureLabel(failure: CimdFetchFailure) {
	return failure.type === 'http' ? `http_${failure.status}` : failure.type
}

/**
 * Classify the provider's metadata fetch error (patched provider sets
 * `status` on HTTP failures; messages are the provider's own).
 */
export function classifyCimdFetchError(error: unknown): CimdFetchFailure {
	const status =
		typeof error === 'object' && error !== null && 'status' in error
			? (error as { status?: unknown }).status
			: undefined
	if (typeof status === 'number' && Number.isInteger(status)) {
		return { type: 'http', status }
	}
	const message = error instanceof Error ? error.message : String(error ?? '')
	const httpStatus = /Failed to fetch client metadata: HTTP (\d{3})/.exec(
		message,
	)
	if (httpStatus) return { type: 'http', status: Number(httpStatus[1]) }
	if (/timed out|timeout/i.test(message)) return { type: 'timeout' }
	if (
		error instanceof TypeError ||
		/network|fetch failed|connection|ECONN|internal error/i.test(message)
	) {
		return { type: 'network_error' }
	}
	return { type: 'invalid_document' }
}

/** Whether a failed live fetch may resolve from a stored or built-in copy. */
export function cimdFallbackDecision(input: {
	clientId: string
	failure: CimdFetchFailure
}): { allowed: boolean; reason: 'outage' | 'worker_blocked_host' | 'none' } {
	const { failure } = input
	if (failure.type === 'timeout' || failure.type === 'network_error') {
		return { allowed: true, reason: 'outage' }
	}
	if (failure.type === 'http') {
		if (failure.status === 429 || failure.status >= 500) {
			return { allowed: true, reason: 'outage' }
		}
		if (
			[401, 403, 404].includes(failure.status) &&
			isWorkerBlockedCimdHost(input.clientId)
		) {
			return { allowed: true, reason: 'worker_blocked_host' }
		}
	}
	return { allowed: false, reason: 'none' }
}

const resolvedStash = new Map<string, { document: string; at: number }>()

/** Provider hook: remember a document that just validated (memory only). */
export function noteResolvedCimdDocument(input: {
	metadataUrl: string
	document: unknown
	now?: number
}) {
	if (!isCimdClientIdUrl(input.metadataUrl)) return
	let text: string
	try {
		text = JSON.stringify(input.document)
	} catch {
		return
	}
	if (!text || text.length > cimdMaxDocumentBytes) return
	const now = input.now ?? Date.now()
	resolvedStash.delete(input.metadataUrl)
	resolvedStash.set(input.metadataUrl, { document: text, at: now })
	while (resolvedStash.size > resolvedStashMaxEntries) {
		const oldest = resolvedStash.keys().next().value
		if (oldest === undefined) break
		resolvedStash.delete(oldest)
	}
}

/** Test helper. */
export function clearResolvedCimdStashForTests() {
	resolvedStash.clear()
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

/**
 * After a successful flow, persist the document this isolate last resolved
 * live for `clientId`. Never throws. A document served from a fallback was
 * never stashed, so a fallback can never refresh its own age.
 */
export async function rememberCimdLastKnownGood(input: {
	env: Env
	clientId: string | null | undefined
	now?: number
}) {
	const clientId = input.clientId
	if (!clientId || !isCimdClientIdUrl(clientId)) return
	const now = input.now ?? Date.now()
	const stashed = resolvedStash.get(clientId)
	if (!stashed || now - stashed.at > resolvedStashTtlMs) return
	try {
		const key = await cimdLastKnownGoodKey(clientId)
		const existing = await readLastKnownGood(input.env, key)
		if (
			existing?.document === stashed.document &&
			now - existing.storedAt < lastKnownGoodRewriteAfterMs
		) {
			return
		}
		await input.env.BUNDLE_ARTIFACTS_KV.put(
			key,
			JSON.stringify({
				document: stashed.document,
				storedAt: stashed.at,
			} satisfies LastKnownGood),
			{ expirationTtl: cimdLastKnownGoodTtlSeconds },
		)
	} catch (error) {
		console.warn('oauth-cimd-last-known-good-write-failed', error)
	}
}

/**
 * Provider hook: a document to resolve from when the live fetch failed, or
 * null. Order: last known good copy (at most 14 days old), then a built-in
 * document for a known client. Logs one `oauth-cimd-fallback` line.
 */
export async function recallCimdLastKnownGood(input: {
	env: Env
	metadataUrl: string
	error: unknown
	now?: number
}): Promise<unknown> {
	const clientId = input.metadataUrl
	const failure = classifyCimdFetchError(input.error)
	const decision = cimdFallbackDecision({ clientId, failure })
	const { host, path } = normalizeCimdClientId(clientId)
	let source: 'last_known_good' | 'built_in' | 'none' = 'none'
	let ageSeconds: number | undefined
	let document: unknown = null
	if (decision.allowed) {
		const now = input.now ?? Date.now()
		const stored = await readLastKnownGood(
			input.env,
			await cimdLastKnownGoodKey(clientId),
		)
		if (stored && now - stored.storedAt < cimdLastKnownGoodTtlSeconds * 1000) {
			try {
				document = JSON.parse(stored.document) as unknown
				source = 'last_known_good'
				ageSeconds = Math.round((now - stored.storedAt) / 1000)
			} catch {
				document = null
			}
		}
		if (document === null) {
			const builtIn = builtInFallbackCimdDocument(clientId)
			if (builtIn !== undefined) {
				document = builtIn
				source = 'built_in'
			}
		}
	}
	console.warn(
		'oauth-cimd-fallback',
		JSON.stringify({
			cimdHost: host,
			cimdPath: path,
			cimdError: cimdFetchFailureLabel(failure),
			policy: decision.reason,
			source,
			...(ageSeconds !== undefined ? { ageSeconds } : {}),
		}),
	)
	return document
}
