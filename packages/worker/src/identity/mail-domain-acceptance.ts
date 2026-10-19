/**
 * Decide whether a domain can receive mail, per RFC 5321 implicit MX:
 * a usable MX accepts; a null MX rejects; otherwise an A or AAAA record
 * accepts. DNS-over-HTTPS failures, timeouts, and non-definitive statuses
 * fail open so a resolver outage does not block signup.
 */

const mailDomainDohTimeoutMs = 2_000
const dohEndpoint = 'https://cloudflare-dns.com/dns-query'

const dnsType = {
	A: 1,
	MX: 15,
	AAAA: 28,
} as const

type DohAnswer = {
	type?: number
	data?: string
}

type DohResponse = {
	Status?: number
	Answer?: Array<DohAnswer>
}

type DohQueryResult =
	| { kind: 'fail_open' }
	| { kind: 'nxdomain' }
	| { kind: 'no_data' }
	| { kind: 'records'; data: Array<string> }

type MailDomainRejectionCode =
	| 'email_domain_nxdomain'
	| 'email_domain_no_mx'
	| 'email_domain_null_mx'

export type MailDomainLookup =
	| { ok: true; failOpen?: boolean }
	| { ok: false; code: MailDomainRejectionCode; error: string }

function rejection(
	code: MailDomainRejectionCode,
	error: string,
): MailDomainLookup {
	return { ok: false, code, error }
}

function mxExchange(data: string) {
	const parts = data.trim().split(/\s+/u)
	const host = (parts.at(-1) ?? '').replace(/\.$/u, '').toLowerCase()
	if (!host || host === '.') return null
	return host
}

async function queryDns(
	name: string,
	type: 'MX' | 'A' | 'AAAA',
	fetchImpl: typeof fetch,
): Promise<DohQueryResult> {
	const url = new URL(dohEndpoint)
	url.searchParams.set('name', name)
	url.searchParams.set('type', type)
	let response: Response
	try {
		response = await fetchImpl(url.toString(), {
			headers: { accept: 'application/dns-json' },
			signal: AbortSignal.timeout(mailDomainDohTimeoutMs),
		})
	} catch (error) {
		console.warn('account-email-doh-failed', { domain: name, type, error })
		return { kind: 'fail_open' }
	}
	if (!response.ok) {
		console.warn('account-email-doh-http-failed', {
			domain: name,
			type,
			status: response.status,
		})
		return { kind: 'fail_open' }
	}
	let payload: DohResponse
	try {
		payload = (await response.json()) as DohResponse
	} catch (error) {
		console.warn('account-email-doh-parse-failed', {
			domain: name,
			type,
			error,
		})
		return { kind: 'fail_open' }
	}
	// 3 = NXDOMAIN. Anything other than NOERROR (0) is not a definitive empty
	// answer (SERVFAIL, REFUSED, FORMERR) and must fail open.
	if (payload.Status === 3) return { kind: 'nxdomain' }
	if (payload.Status !== 0) {
		console.warn('account-email-doh-status-failed', {
			domain: name,
			type,
			status: payload.Status,
		})
		return { kind: 'fail_open' }
	}
	const wanted = dnsType[type]
	const data = (Array.isArray(payload.Answer) ? payload.Answer : [])
		.filter(
			(answer) => answer.type === wanted && typeof answer.data === 'string',
		)
		.map((answer) => answer.data as string)
	if (data.length === 0) return { kind: 'no_data' }
	return { kind: 'records', data }
}

/**
 * `fetchImpl` is required so tests can mock DNS without touching global fetch.
 * Callers in production pass `fetch`.
 */
export async function lookupMailDomainAcceptance(
	domain: string,
	fetchImpl: typeof fetch,
): Promise<MailDomainLookup> {
	const normalized = domain.trim().toLowerCase().replace(/\.$/u, '')
	if (!normalized || normalized.includes('@') || !normalized.includes('.')) {
		return rejection(
			'email_domain_nxdomain',
			'That email domain does not exist. Check the spelling or use a different address.',
		)
	}

	const mx = await queryDns(normalized, 'MX', fetchImpl)
	if (mx.kind === 'fail_open') return { ok: true, failOpen: true }
	if (mx.kind === 'nxdomain') {
		return rejection(
			'email_domain_nxdomain',
			'That email domain does not exist. Check the spelling or use a different address.',
		)
	}
	if (mx.kind === 'records') {
		const exchanges = mx.data.map(mxExchange)
		if (exchanges.some((host) => host !== null)) return { ok: true }
		return rejection(
			'email_domain_null_mx',
			'That email domain does not accept mail (it publishes a null MX record). Use a different address.',
		)
	}

	const [addressV4, addressV6] = await Promise.all([
		queryDns(normalized, 'A', fetchImpl),
		queryDns(normalized, 'AAAA', fetchImpl),
	])
	if (addressV4.kind === 'fail_open' || addressV6.kind === 'fail_open') {
		return { ok: true, failOpen: true }
	}
	if (addressV4.kind === 'records' || addressV6.kind === 'records') {
		return { ok: true }
	}
	return rejection(
		'email_domain_no_mx',
		'That email domain does not accept mail (no MX record and no A or AAAA record). Check the domain or use a different address.',
	)
}
