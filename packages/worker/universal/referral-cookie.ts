/**
 * Last-wins referral attribution cookie. Share links (`?ref=` / `?referral=`)
 * overwrite the previous referrer and expire after one week. Signup persists
 * a `referrals` row from this cookie (or a same-request share link), not from
 * first-touch UTM storage.
 */

import { parseReferralCode } from '#universal/referral-program.ts'

export const referralCookieName = 'kody_ref'
const referralCookieMaxAgeSeconds = 7 * 24 * 60 * 60

export function readReferralCodeFromCookie(
	cookieHeader: string | null | undefined,
): string | null {
	if (!cookieHeader) return null
	let latest: string | null = null
	for (const part of cookieHeader.split(';')) {
		const trimmed = part.trim()
		const separator = trimmed.indexOf('=')
		if (separator <= 0) continue
		const name = trimmed.slice(0, separator)
		if (name !== referralCookieName) continue
		let raw = trimmed.slice(separator + 1)
		try {
			raw = decodeURIComponent(raw)
		} catch {
			continue
		}
		const normalized = parseReferralCode({ body: { ref: raw } })
		if (normalized) latest = normalized
	}
	return latest
}

export function serializeReferralCookie(input: {
	code: string | null
	secure: boolean
}): string {
	const code = parseReferralCode({ body: { ref: input.code } })
	const value = code ? encodeURIComponent(code) : ''
	const maxAge = code ? referralCookieMaxAgeSeconds : 0
	const secure = input.secure ? '; Secure' : ''
	return `${referralCookieName}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`
}

/**
 * Current-request share link wins over a stored cookie so a signup that
 * carries `?ref=` (or posts `referralCode`) attributes that referrer.
 */
export function resolveReferralCodeForSignup(input: {
	searchParams?: URLSearchParams | null
	body?: unknown
	cookieHeader?: string | null
}): string | null {
	return (
		parseReferralCode({
			searchParams: input.searchParams,
			body: input.body,
		}) ?? readReferralCodeFromCookie(input.cookieHeader)
	)
}
