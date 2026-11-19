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
	/**
	 * Lowercased `header.from=` domain of the DMARC clause that passed: the
	 * RFC 5322 From domain the authserv evaluated. Null when DMARC did not
	 * pass or the stamp did not name it.
	 */
	dmarcHeaderFrom: string | null
	authenticated: boolean
	suspect: boolean
	reason: string | null
}

/** Generic quarantine reason shown in the inbox UI for auth failures. */
export const failedSenderAuthenticationReason = 'Failed sender authentication.'

const methodClausePattern = /^(spf|dkim|dmarc)=([^\s(;]+)/i
const headerFromPropertyPattern = /(?:^|\s)header\.from=("?)([^\s;()"]+)\1/i

const knownMethodResults = new Set<string>(emailAuthMethodResults)

function parseMethodResultToken(token: string): EmailAuthMethodResult {
	const normalized = token.toLowerCase()
	if (knownMethodResults.has(normalized)) {
		return normalized as EmailAuthMethodResult
	}
	return 'unknown'
}

/** Fetch joins duplicate headers with commas; stop at the first raw comma. */
function firstAuthResultsStamp(value: string): string | null {
	return value.split(',', 1)[0]?.trim() || null
}

function parseAuthMethodResults(authResults: string | null): {
	spf: EmailAuthMethodResult
	dkim: EmailAuthMethodResult
	dmarc: EmailAuthMethodResult
	dmarcHeaderFrom: string | null
} {
	let spf: EmailAuthMethodResult = 'unknown'
	let dkim: EmailAuthMethodResult = 'unknown'
	let dmarc: EmailAuthMethodResult = 'unknown'
	let dmarcHeaderFrom: string | null = null
	const seen = new Set<string>()
	if (!authResults?.trim()) {
		return { spf, dkim, dmarc, dmarcHeaderFrom }
	}

	for (const clause of authResults.split(';')) {
		const match = clause.trim().match(methodClausePattern)
		if (!match) continue
		const method = match[1]!.toLowerCase()
		const result = parseMethodResultToken(match[2]!)
		const first = !seen.has(method)
		seen.add(method)
		if (method === 'spf') {
			if (first) spf = result
		} else if (method === 'dkim') {
			if (first || result === 'pass') dkim = result
		} else if (method === 'dmarc' && first) {
			if (result === 'pass') {
				dmarcHeaderFrom =
					clause.match(headerFromPropertyPattern)?.[2]?.toLowerCase() ?? null
			}
			dmarc = result
		}
	}

	return { spf, dkim, dmarc, dmarcHeaderFrom }
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

function trustedLeftmostStamp(headers: Headers, name: string): string | null {
	const raw = headers.get(name)?.trim()
	if (!raw) return null
	const leftmost = firstAuthResultsStamp(raw)
	if (!leftmost) return null
	const authservId = extractAuthservId(leftmost)
	if (!authservId || !isCloudflareEmailAuthservId(authservId)) return null
	return leftmost
}

/**
 * Prefer Cloudflare-stamped Authentication-Results on the Worker message
 * headers. Never trust sender-forged AR/ARC rows (wrong authserv-id), never
 * scan later comma-joined stamps for a Cloudflare id, and do not fall back to
 * third-party ARC seals when Cloudflare did not stamp first.
 *
 * Reads `message.headers` only (Email Worker), not postal-mime body headers.
 */
export function selectTrustedCloudflareAuthResults(
	headers: Headers,
): string | null {
	return (
		trustedLeftmostStamp(headers, 'Authentication-Results') ??
		trustedLeftmostStamp(headers, 'ARC-Authentication-Results')
	)
}

/**
 * Resolve SPF/DKIM/DMARC method results from a trusted Authentication-Results
 * (or Cloudflare ARC-Authentication-Results) header into a quarantine verdict.
 *
 * Policy:
 * - SPF and DMARC use the first clause; DKIM passes if any signature passes.
 * - Quarantine (suspect) when DMARC is `fail`, or when there is no DMARC
 *   policy result (`none`) and both SPF and DKIM failed (`fail`/`softfail`).
 * - `authenticated` when DMARC is `pass`, or when (SPF or DKIM is `pass`) and
 *   DMARC is not `fail`.
 * - Missing / untrusted header (all three methods `unknown`) fails open:
 *   authenticated false, suspect false, so locally-injected/dev mail and
 *   unexpected upstream changes do not quarantine everything.
 * - `reason` is set only when suspect.
 */
export function resolveInboundEmailAuthVerdict(
	authResults: string | null,
): EmailAuthVerdict {
	// Defense in depth: never merge method results across a second stamp.
	const singleStamp = authResults ? firstAuthResultsStamp(authResults) : null
	const { spf, dkim, dmarc, dmarcHeaderFrom } =
		parseAuthMethodResults(singleStamp)

	if (spf === 'unknown' && dkim === 'unknown' && dmarc === 'unknown') {
		return {
			spf,
			dkim,
			dmarc,
			dmarcHeaderFrom,
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
		dmarcHeaderFrom,
		authenticated,
		suspect,
		reason: suspect ? failedSenderAuthenticationReason : null,
	}
}
