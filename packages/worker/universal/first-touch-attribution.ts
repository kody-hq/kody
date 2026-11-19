/**
 * First-touch marketing attribution captured at signup (email or OAuth).
 * These fields are the acquisition story. Values are write-once on the user
 * row and never overwrite later UTMs. The browser keeps the first touch in
 * the `kody_first_touch` cookie until signup reads and clears it.
 * Referral share links use a last-wins `kody_ref` cookie, not this payload.
 */

export type FirstTouchAttribution = {
	utmSource: string | null
	utmMedium: string | null
	utmCampaign: string | null
	utmContent: string | null
	utmTerm: string | null
	landingPath: string | null
	referrer: string | null
}

export const emptyFirstTouchAttribution: FirstTouchAttribution = {
	utmSource: null,
	utmMedium: null,
	utmCampaign: null,
	utmContent: null,
	utmTerm: null,
	landingPath: null,
	referrer: null,
}

const maxAttributionValueLength = 200
const maxLandingPathLength = 500
const maxReferrerLength = 500

function normalizeAttributionValue(
	value: unknown,
	maxLength = maxAttributionValueLength,
): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.slice(0, maxLength)
}

function normalizeLandingPath(value: unknown): string | null {
	const raw = normalizeAttributionValue(value, maxLandingPathLength)
	if (!raw) return null
	if (!raw.startsWith('/')) return null
	if (raw.startsWith('//')) return null
	return raw
}

function normalizeReferrer(value: unknown): string | null {
	return normalizeAttributionValue(value, maxReferrerLength)
}

export function hasFirstTouchAttribution(
	value: FirstTouchAttribution | null | undefined,
): boolean {
	if (!value) return false
	return (
		value.utmSource != null ||
		value.utmMedium != null ||
		value.utmCampaign != null ||
		value.utmContent != null ||
		value.utmTerm != null ||
		value.landingPath != null ||
		value.referrer != null
	)
}

export function parseFirstTouchAttribution(input: {
	searchParams?: URLSearchParams | null
	landingPath?: unknown
	referrer?: unknown
}): FirstTouchAttribution {
	const params = input.searchParams ?? null

	function readParam(key: string) {
		return normalizeAttributionValue(params?.get(key))
	}

	return {
		utmSource: readParam('utm_source'),
		utmMedium: readParam('utm_medium'),
		utmCampaign: readParam('utm_campaign'),
		utmContent: readParam('utm_content'),
		utmTerm: readParam('utm_term'),
		landingPath:
			normalizeLandingPath(input.landingPath) ??
			normalizeLandingPath(params?.get('landing_path')),
		referrer:
			normalizeReferrer(input.referrer) ??
			normalizeReferrer(params?.get('referrer')),
	}
}

export function firstTouchAttributionToUserColumns(
	attribution: FirstTouchAttribution | null | undefined,
): {
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	first_touch_landing_path: string | null
	first_touch_referrer: string | null
} {
	const value = attribution ?? emptyFirstTouchAttribution
	return {
		utm_source: value.utmSource,
		utm_medium: value.utmMedium,
		utm_campaign: value.utmCampaign,
		utm_content: value.utmContent,
		utm_term: value.utmTerm,
		first_touch_landing_path: value.landingPath,
		first_touch_referrer: value.referrer,
	}
}

/**
 * Columns to pass into `db.create(usersTable, …)`. The ORM treats optional
 * text columns as `string | undefined` (omit) rather than SQL NULL, so absent
 * attribution fields are dropped instead of set to null.
 */
export function firstTouchAttributionCreateFields(
	attribution: FirstTouchAttribution | null | undefined,
): Partial<{
	utm_source: string
	utm_medium: string
	utm_campaign: string
	utm_content: string
	utm_term: string
	first_touch_landing_path: string
	first_touch_referrer: string
}> {
	const columns = firstTouchAttributionToUserColumns(attribution)
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(columns)) {
		if (typeof value === 'string' && value.length > 0) {
			out[key] = value
		}
	}
	return out
}

export const firstTouchAttributionCookieName = 'kody_first_touch'
const firstTouchAttributionCookieMaxAgeSeconds = 7 * 24 * 60 * 60
// Browsers drop cookies over 4096 bytes, and percent-encoding can grow the
// capped values past that, so the least useful fields go first.
const maxFirstTouchCookieValueLength = 3800
const cookieFieldDropOrder = [
	'referrer',
	'landing_path',
	'utm_term',
	'utm_content',
	'utm_campaign',
	'utm_medium',
] as const

function serializeFirstTouchAttributionCookieValue(
	attribution: FirstTouchAttribution | null | undefined,
): string {
	const params = new URLSearchParams()
	if (!attribution) return ''
	if (attribution.utmSource) params.set('utm_source', attribution.utmSource)
	if (attribution.utmMedium) params.set('utm_medium', attribution.utmMedium)
	if (attribution.utmCampaign)
		params.set('utm_campaign', attribution.utmCampaign)
	if (attribution.utmContent) params.set('utm_content', attribution.utmContent)
	if (attribution.utmTerm) params.set('utm_term', attribution.utmTerm)
	if (attribution.landingPath)
		params.set('landing_path', attribution.landingPath)
	if (attribution.referrer) params.set('referrer', attribution.referrer)
	for (const key of cookieFieldDropOrder) {
		if (params.toString().length <= maxFirstTouchCookieValueLength) break
		params.delete(key)
	}
	return params.toString()
}

/**
 * `Set-Cookie` / `document.cookie` string for the first-touch cookie. Pass
 * `attribution: null` to clear it. The value is URL-encoded query syntax, so
 * it never contains `;`, `,`, quotes, or whitespace.
 */
export function serializeFirstTouchAttributionCookie(input: {
	attribution: FirstTouchAttribution | null
	secure: boolean
}): string {
	const value = serializeFirstTouchAttributionCookieValue(input.attribution)
	const maxAge = value ? firstTouchAttributionCookieMaxAgeSeconds : 0
	const secure = input.secure ? '; Secure' : ''
	return `${firstTouchAttributionCookieName}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`
}

/** Re-applies the parse caps because the browser can edit the cookie. */
export function readFirstTouchAttributionFromCookie(
	cookieHeader: string | null | undefined,
): FirstTouchAttribution | null {
	if (!cookieHeader) return null
	for (const part of cookieHeader.split(';')) {
		const trimmed = part.trim()
		const separator = trimmed.indexOf('=')
		if (separator <= 0) continue
		if (trimmed.slice(0, separator) !== firstTouchAttributionCookieName)
			continue
		const attribution = parseFirstTouchAttribution({
			searchParams: new URLSearchParams(trimmed.slice(separator + 1)),
		})
		if (hasFirstTouchAttribution(attribution)) return attribution
	}
	return null
}
