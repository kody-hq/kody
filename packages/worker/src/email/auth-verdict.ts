export const emailAuthMethodResults = [
	'pass',
	'fail',
	'softfail',
	'neutral',
	'none',
	'policy',
	'temperror',
	'permerror',
	'unknown',
] as const
export type EmailAuthMethodResult = (typeof emailAuthMethodResults)[number]

export type EmailAuthVerdict = {
	spf: EmailAuthMethodResult
	dkim: EmailAuthMethodResult
	dmarc: EmailAuthMethodResult
	authenticated: boolean
	suspect: boolean
	reason: string | null
}

/** Generic quarantine reason shown in the inbox UI for auth failures. */
export const failedSenderAuthenticationReason = 'Failed sender authentication.'

const methodClausePattern = /^(spf|dkim|dmarc)=([^\s(;]+)/i

const knownMethodResults = new Set<string>(emailAuthMethodResults)

function parseMethodResultToken(token: string): EmailAuthMethodResult {
	const normalized = token.toLowerCase()
	if (knownMethodResults.has(normalized)) {
		return normalized as EmailAuthMethodResult
	}
	return 'unknown'
}

function mergeMethodResult(
	current: EmailAuthMethodResult,
	next: EmailAuthMethodResult,
): EmailAuthMethodResult {
	if (current === 'pass' || next === 'pass') return 'pass'
	if (current !== 'unknown') return current
	return next
}

function parseAuthMethodResults(authResults: string | null): {
	spf: EmailAuthMethodResult
	dkim: EmailAuthMethodResult
	dmarc: EmailAuthMethodResult
} {
	let spf: EmailAuthMethodResult = 'unknown'
	let dkim: EmailAuthMethodResult = 'unknown'
	let dmarc: EmailAuthMethodResult = 'unknown'
	if (!authResults?.trim()) {
		return { spf, dkim, dmarc }
	}

	for (const clause of authResults.split(';')) {
		const match = clause.trim().match(methodClausePattern)
		if (!match) continue
		const method = match[1]!.toLowerCase()
		const result = parseMethodResultToken(match[2]!)
		if (method === 'spf') {
			spf = mergeMethodResult(spf, result)
		} else if (method === 'dkim') {
			dkim = mergeMethodResult(dkim, result)
		} else if (method === 'dmarc') {
			dmarc = mergeMethodResult(dmarc, result)
		}
	}

	return { spf, dkim, dmarc }
}

function methodFailed(result: EmailAuthMethodResult): boolean {
	return result === 'fail' || result === 'softfail'
}

/**
 * Authserv-id from an Authentication-Results or ARC-Authentication-Results
 * value. Skips ARC `i=` instance tokens and method clauses.
 */
export function extractAuthservId(headerValue: string): string | null {
	for (const part of headerValue.split(';')) {
		const token = part.trim()
		if (!token) continue
		if (/^i=\d+$/i.test(token)) continue
		if (/^(spf|dkim|dmarc|arc)=/i.test(token)) continue
		const id = token.split(/\s+/)[0]?.toLowerCase()
		return id || null
	}
	return null
}

/**
 * Cloudflare Email Routing stamps results under `*.cloudflare.net` (commonly
 * `mx.cloudflare.net`). Sender-forged authserv-ids must not match lookalikes.
 */
export function isCloudflareEmailAuthservId(authservId: string): boolean {
	const id = authservId.trim().toLowerCase()
	return id === 'cloudflare.net' || id.endsWith('.cloudflare.net')
}

/**
 * The Fetch `Headers` API joins duplicate header names with `", "`. Authentication-Results
 * must not be parsed as one clause list across stamps, so split before the next
 * authserv-id-looking segment.
 */
export function splitCombinedAuthResultsHeader(value: string): Array<string> {
	return value
		.split(/,(?=\s*[^,;=/\s]+;)/)
		.map((part) => part.trim())
		.filter(Boolean)
}

function listHeaderValues(headers: Headers, name: string): Array<string> {
	const needle = name.toLowerCase()
	const values: Array<string> = []
	for (const [key, value] of headers) {
		if (key.toLowerCase() !== needle) continue
		for (const part of splitCombinedAuthResultsHeader(value)) {
			values.push(part)
		}
	}
	return values
}

/**
 * Prefer Cloudflare-stamped Authentication-Results on the Worker message
 * headers. Never trust sender-forged AR/ARC rows (wrong authserv-id), and do
 * not fall back to third-party ARC seals when Cloudflare did not stamp.
 *
 * Reads `message.headers` only (Email Worker), not postal-mime body headers.
 */
export function selectTrustedCloudflareAuthResults(
	headers: Headers,
): string | null {
	for (const value of listHeaderValues(headers, 'Authentication-Results')) {
		const authservId = extractAuthservId(value)
		if (authservId && isCloudflareEmailAuthservId(authservId)) return value
	}
	for (const value of listHeaderValues(headers, 'ARC-Authentication-Results')) {
		const authservId = extractAuthservId(value)
		if (authservId && isCloudflareEmailAuthservId(authservId)) return value
	}
	return null
}

/**
 * Resolve SPF/DKIM/DMARC method results from a trusted Authentication-Results
 * (or Cloudflare ARC-Authentication-Results) header into a quarantine verdict.
 *
 * Policy:
 * - Quarantine (suspect) when DMARC is `fail`, or when there is no DMARC
 *   policy result (`none`) and both SPF and DKIM failed (`fail`/`softfail`).
 * - `authenticated` when DMARC is `pass`, or when (SPF or DKIM is `pass`) and
 *   DMARC is not `fail`.
 * - Missing / untrusted header (all three methods `unknown`) fails open:
 *   authenticated false, suspect false — so locally-injected/dev mail and
 *   unexpected upstream changes do not quarantine everything.
 * - `reason` is set only when suspect.
 */
export function resolveInboundEmailAuthVerdict(
	authResults: string | null,
): EmailAuthVerdict {
	const { spf, dkim, dmarc } = parseAuthMethodResults(authResults)

	if (spf === 'unknown' && dkim === 'unknown' && dmarc === 'unknown') {
		return {
			spf,
			dkim,
			dmarc,
			authenticated: false,
			suspect: false,
			reason: null,
		}
	}

	const authenticated =
		dmarc === 'pass' ||
		((spf === 'pass' || dkim === 'pass') && dmarc !== 'fail')
	// No DMARC policy result: explicit `none`, or method results without a
	// dmarc= clause (`unknown`). Missing headers entirely already returned.
	const noDmarcPolicy = dmarc === 'none' || dmarc === 'unknown'
	const suspect =
		dmarc === 'fail' ||
		(noDmarcPolicy && methodFailed(spf) && methodFailed(dkim))

	return {
		spf,
		dkim,
		dmarc,
		authenticated,
		suspect,
		reason: suspect ? failedSenderAuthenticationReason : null,
	}
}
