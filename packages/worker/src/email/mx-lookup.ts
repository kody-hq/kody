/**
 * Resolve a recipient domain's MX hosts and map them to provider keys used by
 * the rejecting-provider hold. Workers have no resolver.bind, so lookups use
 * Cloudflare DNS-over-HTTPS. Results are cached in D1.
 */

import { getDomain } from 'tldts'

export const emailMxLookupCacheTtlSeconds = 6 * 60 * 60
export const emailMxLookupNegativeTtlSeconds = 15 * 60
export const emailMxDohTimeoutMs = 3_000

const dohEndpoint = 'https://cloudflare-dns.com/dns-query'

/** Static MX-host suffixes used when DoH is unavailable or before observations. */
export const emailProviderMxSeedSuffixes = [
	'messagingengine.com',
	'simplelogin.co',
] as const

type DohMxAnswer = {
	name?: string
	type?: number
	TTL?: number
	data?: string
}

type DohMxResponse = {
	Status?: number
	Answer?: Array<DohMxAnswer>
}

export type EmailMxLookupResult = {
	domain: string
	mxHosts: Array<string>
	providerKeys: Array<string>
	fromCache: boolean
}

/**
 * Collapse an MX hostname to a stable provider key (registrable domain).
 * `in1-smtp.messagingengine.com` → `messagingengine.com`.
 * Uses tldts so multi-label public suffixes (`co.uk`, `com.au`) are not
 * mistaken for the provider key.
 */
export function providerKeyFromMxHost(mxHost: string): string | null {
	const host = mxHost.trim().toLowerCase().replace(/\.$/u, '')
	if (!host || host.includes(' ') || !host.includes('.')) return null
	const registrable = getDomain(host)
	if (registrable) return registrable.toLowerCase()
	const labels = host.split('.').filter(Boolean)
	if (labels.length < 2) return null
	return labels.slice(-2).join('.')
}

export function normalizeEmailDomain(domain: string): string | null {
	const normalized = domain.trim().toLowerCase().replace(/\.$/u, '')
	if (!normalized || normalized.includes('@') || !normalized.includes('.')) {
		return null
	}
	return normalized
}

function parseMxData(data: string): string | null {
	const trimmed = data.trim()
	if (!trimmed) return null
	const parts = trimmed.split(/\s+/u)
	const host = (parts.length >= 2 ? parts[parts.length - 1] : parts[0]) ?? ''
	const normalized = host.toLowerCase().replace(/\.$/u, '')
	return normalized.length > 0 ? normalized : null
}

export async function lookupMxViaDoh(
	domain: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ mxHosts: Array<string>; ttlSeconds: number }> {
	const normalized = normalizeEmailDomain(domain)
	if (!normalized)
		return { mxHosts: [], ttlSeconds: emailMxLookupNegativeTtlSeconds }

	const url = new URL(dohEndpoint)
	url.searchParams.set('name', normalized)
	url.searchParams.set('type', 'MX')

	let response: Response
	try {
		response = await fetchImpl(url.toString(), {
			headers: { Accept: 'application/dns-json' },
			signal: AbortSignal.timeout(emailMxDohTimeoutMs),
		})
	} catch (error) {
		console.warn('email-mx-doh-request-failed', error)
		return { mxHosts: [], ttlSeconds: emailMxLookupNegativeTtlSeconds }
	}
	if (!response.ok) {
		console.warn('email-mx-doh-http-failed', {
			status: response.status,
			domain: normalized,
		})
		return { mxHosts: [], ttlSeconds: emailMxLookupNegativeTtlSeconds }
	}

	let payload: DohMxResponse
	try {
		payload = (await response.json()) as DohMxResponse
	} catch (error) {
		console.warn('email-mx-doh-parse-failed', error)
		return { mxHosts: [], ttlSeconds: emailMxLookupNegativeTtlSeconds }
	}
	const answers = Array.isArray(payload.Answer) ? payload.Answer : []
	const mxHosts: Array<string> = []
	let minTtl = emailMxLookupCacheTtlSeconds
	for (const answer of answers) {
		if (answer.type !== 15 || typeof answer.data !== 'string') continue
		const host = parseMxData(answer.data)
		if (!host) continue
		if (!mxHosts.includes(host)) mxHosts.push(host)
		if (
			typeof answer.TTL === 'number' &&
			Number.isFinite(answer.TTL) &&
			answer.TTL > 0
		) {
			minTtl = Math.min(minTtl, answer.TTL)
		}
	}
	if (mxHosts.length === 0) {
		return { mxHosts: [], ttlSeconds: emailMxLookupNegativeTtlSeconds }
	}
	return {
		mxHosts,
		ttlSeconds: Math.max(
			emailMxLookupNegativeTtlSeconds,
			Math.min(emailMxLookupCacheTtlSeconds, minTtl),
		),
	}
}

export function providerKeysFromMxHosts(mxHosts: ReadonlyArray<string>) {
	const keys = new Set<string>()
	for (const host of mxHosts) {
		const key = providerKeyFromMxHost(host)
		if (key) keys.add(key)
	}
	return [...keys].sort()
}

async function readMxCache(input: {
	db: D1Database
	domain: string
	now: Date
}): Promise<EmailMxLookupResult | null> {
	const row = await input.db
		.prepare(
			`SELECT provider_keys_json, mx_hosts_json, expires_at
			 FROM email_mx_lookup_cache
			 WHERE domain = ?`,
		)
		.bind(input.domain)
		.first<{
			provider_keys_json: string
			mx_hosts_json: string
			expires_at: string
		}>()
	if (!row) return null
	const expiresAt = Date.parse(row.expires_at)
	if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
		return null
	}
	let mxHosts: Array<string>
	let providerKeys: Array<string>
	try {
		mxHosts = JSON.parse(row.mx_hosts_json) as Array<string>
		providerKeys = JSON.parse(row.provider_keys_json) as Array<string>
	} catch {
		return null
	}
	if (!Array.isArray(mxHosts) || !Array.isArray(providerKeys)) return null
	return {
		domain: input.domain,
		mxHosts: mxHosts.filter((value) => typeof value === 'string'),
		providerKeys: providerKeys.filter((value) => typeof value === 'string'),
		fromCache: true,
	}
}

async function writeMxCache(input: {
	db: D1Database
	domain: string
	mxHosts: Array<string>
	providerKeys: Array<string>
	ttlSeconds: number
	now: Date
}) {
	const lookedUpAt = input.now.toISOString()
	const expiresAt = new Date(
		input.now.getTime() + input.ttlSeconds * 1000,
	).toISOString()
	await input.db
		.prepare(
			`INSERT INTO email_mx_lookup_cache (
				domain, provider_keys_json, mx_hosts_json, looked_up_at, expires_at
			 ) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(domain) DO UPDATE SET
				provider_keys_json = excluded.provider_keys_json,
				mx_hosts_json = excluded.mx_hosts_json,
				looked_up_at = excluded.looked_up_at,
				expires_at = excluded.expires_at`,
		)
		.bind(
			input.domain,
			JSON.stringify(input.providerKeys),
			JSON.stringify(input.mxHosts),
			lookedUpAt,
			expiresAt,
		)
		.run()
}

/**
 * Resolve MX provider keys for a recipient email domain, using D1 cache then
 * DoH. Failures return an empty provider list so sends fail open for the
 * provider-hold path (recipient cooldown still applies).
 */
export async function resolveRecipientMxProviders(input: {
	db: D1Database
	recipientOrDomain: string
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<EmailMxLookupResult> {
	const now = input.now ?? new Date()
	const raw = input.recipientOrDomain.trim().toLowerCase()
	const domain = normalizeEmailDomain(
		raw.includes('@') ? (raw.split('@').pop() ?? '') : raw,
	)
	if (!domain) {
		return { domain: '', mxHosts: [], providerKeys: [], fromCache: false }
	}

	const cached = await readMxCache({ db: input.db, domain, now })
	if (cached) return cached

	const lookedUp = await lookupMxViaDoh(domain, input.fetchImpl ?? fetch)
	const providerKeys = providerKeysFromMxHosts(lookedUp.mxHosts)
	try {
		await writeMxCache({
			db: input.db,
			domain,
			mxHosts: lookedUp.mxHosts,
			providerKeys,
			ttlSeconds: lookedUp.ttlSeconds,
			now,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		// Incomplete test doubles and pre-migration schemas omit the cache
		// table or `.run`. Fail open without noise; unexpected errors warn.
		if (
			!(
				error instanceof TypeError ||
				/no such table/i.test(message) ||
				/\.run is not a function/i.test(message)
			)
		) {
			console.warn('email-mx-cache-write-failed', error)
		}
	}
	return {
		domain,
		mxHosts: lookedUp.mxHosts,
		providerKeys,
		fromCache: false,
	}
}
