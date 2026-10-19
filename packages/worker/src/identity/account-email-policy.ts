/**
 * Shared rules for an address that will be stored as an account email.
 * Syntax, common typos, and disposable domains are synchronous. Mail-domain
 * DNS runs from `mail-domain-acceptance.ts` via `assessAccountEmail`.
 */

import { disposableEmailDomainList } from './disposable-email-domains.ts'
import {
	lookupMailDomainAcceptance,
	type MailDomainLookup,
} from './mail-domain-acceptance.ts'

const disposableEmailDomains = new Set<string>(disposableEmailDomainList)

/**
 * Never block these even if a refreshed disposable list contains them.
 * `example.com` stays allowed so tests and documentation addresses work.
 */
const protectedEmailDomains = new Set([
	'aol.com',
	'example.com',
	'fastmail.com',
	'gmail.com',
	'googlemail.com',
	'hotmail.com',
	'icloud.com',
	'live.com',
	'me.com',
	'outlook.com',
	'proton.me',
	'protonmail.com',
	'yahoo.com',
])

/**
 * Explicit mistypes. `.con` and `.cmo` are handled for every domain below
 * because those TLDs are not delegated; `.co` and `.cm` are real TLDs and
 * only the entries here are rewritten.
 */
const emailDomainTypos: Record<string, string> = {
	'gamil.com': 'gmail.com',
	'gmai.com': 'gmail.com',
	'gmail.cm': 'gmail.com',
	'gmail.cmo': 'gmail.com',
	'gmail.co': 'gmail.com',
	'gmail.con': 'gmail.com',
	'gmal.com': 'gmail.com',
	'gmial.com': 'gmail.com',
	'gnail.com': 'gmail.com',
	'hotmai.com': 'hotmail.com',
	'hotmail.cm': 'hotmail.com',
	'hotmail.cmo': 'hotmail.com',
	'hotmail.co': 'hotmail.com',
	'hotmail.con': 'hotmail.com',
	'hotmal.com': 'hotmail.com',
	'hotmial.com': 'hotmail.com',
	'icloud.cm': 'icloud.com',
	'icloud.cmo': 'icloud.com',
	'icloud.co': 'icloud.com',
	'icloud.con': 'icloud.com',
	'icloudcom.com': 'icloud.com',
	'iclooud.com': 'icloud.com',
	'icloudl.com': 'icloud.com',
	'iclud.com': 'icloud.com',
	'icoud.com': 'icloud.com',
	'outllok.com': 'outlook.com',
	'outlok.com': 'outlook.com',
	'outlook.cm': 'outlook.com',
	'outlook.cmo': 'outlook.com',
	'outlook.co': 'outlook.com',
	'outlook.con': 'outlook.com',
	'outloo.com': 'outlook.com',
	'yahoo.cm': 'yahoo.com',
	'yahoo.cmo': 'yahoo.com',
	'yahoo.co': 'yahoo.com',
	'yahoo.con': 'yahoo.com',
	'yahooo.com': 'yahoo.com',
	'yaho.com': 'yahoo.com',
	'yhaoo.com': 'yahoo.com',
}

const localPartPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

const accountEmailRejectionCodes = [
	'invalid_email',
	'email_typo',
	'disposable_email',
	'email_domain_nxdomain',
	'email_domain_no_mx',
	'email_domain_null_mx',
] as const

export type AccountEmailRejectionCode =
	(typeof accountEmailRejectionCodes)[number]

export type AccountEmailRejection = {
	ok: false
	code: AccountEmailRejectionCode
	error: string
	suggestion?: string
}

export type AccountEmailAcceptance = {
	ok: true
	email: string
}

export type AccountEmailAssessment =
	| AccountEmailAcceptance
	| AccountEmailRejection

export function parseAccountEmail(
	email: string,
): { email: string; local: string; domain: string } | null {
	const normalized = email.trim().toLowerCase()
	if (normalized.length < 3 || normalized.length > 254) return null
	const at = normalized.indexOf('@')
	if (at <= 0 || at !== normalized.lastIndexOf('@')) return null
	const local = normalized.slice(0, at)
	const domain = normalized.slice(at + 1)
	if (local.length > 64 || domain.length > 253) return null
	if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
		return null
	}
	if (!localPartPattern.test(local)) return null
	const labels = domain.split('.')
	if (labels.length < 2) return null
	if (labels.some((label) => !domainLabelPattern.test(label))) return null
	const tld = labels.at(-1)
	if (!tld || !isAcceptedEmailTld(tld)) return null
	return { email: `${local}@${domain}`, local, domain }
}

/** ASCII TLDs, plus punycode IDN TLDs such as `xn--p1ai`. */
function isAcceptedEmailTld(tld: string) {
	if (/^[a-z]{2,}$/u.test(tld)) return true
	return /^xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/u.test(tld)
}

export function isDisposableEmailDomain(domain: string) {
	let current = domain.trim().toLowerCase().replace(/\.$/u, '')
	while (current.includes('.')) {
		if (protectedEmailDomains.has(current)) return false
		if (disposableEmailDomains.has(current)) return true
		const dot = current.indexOf('.')
		current = current.slice(dot + 1)
	}
	return false
}

function suggestedDomain(domain: string): string | null {
	const direct = emailDomainTypos[domain]
	if (direct) return direct
	if (domain.endsWith('.con') || domain.endsWith('.cmo')) {
		const rewritten = `${domain.slice(0, -3)}com`
		// `gmial.con` should become gmail.com, not stop at gmial.com.
		return suggestedDomain(rewritten) ?? rewritten
	}
	const dot = domain.indexOf('.')
	if (dot === -1) return null
	const parent = suggestedDomain(domain.slice(dot + 1))
	if (!parent) return null
	return `${domain.slice(0, dot + 1)}${parent}`
}

export function accountEmailTypoSuggestion(email: string) {
	const parsed = parseAccountEmail(email)
	if (!parsed) return null
	const domain = suggestedDomain(parsed.domain)
	if (!domain || domain === parsed.domain) return null
	return `${parsed.local}@${domain}`
}

function invalidEmailRejection(): AccountEmailRejection {
	return {
		ok: false,
		code: 'invalid_email',
		error: 'Enter a valid email address, like name@gmail.com.',
	}
}

function typoRejection(suggestion: string): AccountEmailRejection {
	return {
		ok: false,
		code: 'email_typo',
		error: `That email domain looks mistyped. Did you mean ${suggestion}?`,
		suggestion,
	}
}

function disposableRejection(): AccountEmailRejection {
	return {
		ok: false,
		code: 'disposable_email',
		error:
			'That email domain is disposable and cannot be used for an account. Use a personal or work address you control.',
	}
}

/**
 * Syntax, typo, and disposable checks. Does not query DNS.
 * Login must not call this: existing accounts with a malformed address can
 * still sign in.
 */
export function assessAccountEmailSyntax(
	email: string,
): AccountEmailAssessment {
	const parsed = parseAccountEmail(email)
	if (!parsed) return invalidEmailRejection()
	const suggestion = accountEmailTypoSuggestion(parsed.email)
	if (suggestion) {
		const suggestedDomainName = suggestion.split('@').at(1) ?? ''
		if (isDisposableEmailDomain(suggestedDomainName)) {
			return disposableRejection()
		}
		return typoRejection(suggestion)
	}
	if (isDisposableEmailDomain(parsed.domain)) return disposableRejection()
	return { ok: true, email: parsed.email }
}

function isVitestRuntime() {
	const runtime = globalThis as {
		process?: { env?: { VITEST?: string } }
	}
	return runtime.process?.env?.VITEST === 'true'
}

/**
 * Full account-email check. Under Vitest, DNS is skipped unless `fetchImpl`
 * is passed, so signup tests that stub global `fetch` for the mail API stay
 * deterministic. Production always queries DNS-over-HTTPS.
 */
export async function assessAccountEmail(
	email: string,
	options?: { fetchImpl?: typeof fetch; allowExampleDomain?: boolean },
): Promise<AccountEmailAssessment> {
	const syntax = assessAccountEmailSyntax(email)
	if (!syntax.ok) return syntax
	// example.com publishes a null MX. Unit tests skip DNS under Vitest.
	// Local dev, preview, and Playwright permit that fixture only; production
	// still rejects it.
	if (options?.allowExampleDomain && syntax.email.endsWith('@example.com')) {
		return syntax
	}
	if (!options?.fetchImpl && isVitestRuntime()) {
		return syntax
	}
	const lookup: MailDomainLookup = await lookupMailDomainAcceptance(
		syntax.email.split('@').at(1) ?? '',
		options?.fetchImpl ?? fetch,
	)
	if (!lookup.ok) return lookup
	return syntax
}
