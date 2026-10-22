import { createCookie } from 'remix/cookie'
import {
	isOauthProviderId,
	type OauthProviderId,
} from '#app/oauth-providers.ts'
import {
	hasFirstTouchAttribution,
	parseFirstTouchAttribution,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'

/**
 * Short-lived signed cookie that parks a verified social identity while the
 * person chooses a permanent username. Account creation waits until they
 * submit; the cookie alone never grants a session.
 *
 * Cleared on successful signup, expiry, or when the person abandons the flow.
 * `csrf` is echoed in the choose-username form so the POST must match this
 * cookie (single-use consume clears it).
 */
const oauthPendingSignupMaxAgeSeconds = 60 * 10

export type OauthPendingSignup = {
	provider: OauthProviderId
	providerUserId: string
	email: string
	providerUsername: string | null
	displayName: string | null
	suggestedUsername: string
	redirectTo: string | null
	attribution: FirstTouchAttribution | null
	csrf: string
	/** Ephemeral Discord guild.join token; discarded after signup. */
	accessToken: string | null
	issuedAt: number
}

type StoredOauthPendingSignup = OauthPendingSignup & { v: 1 }

let pendingCookie: ReturnType<typeof createCookie> | null = null
let pendingSecret: string | null = null

export function setOauthPendingSignupSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for OAuth pending signup signing.')
	}

	if (pendingCookie && pendingSecret === secret) {
		return
	}

	pendingSecret = secret
	pendingCookie = createCookie('kody_oauth_pending', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: oauthPendingSignupMaxAgeSeconds,
		secrets: [secret],
	})
}

function getPendingCookie() {
	if (!pendingCookie) {
		throw new Error(
			'OAuth pending signup cookie not configured. Call setOauthPendingSignupSecret.',
		)
	}

	return pendingCookie
}

function parseAttributionField(value: unknown): FirstTouchAttribution | null {
	if (value == null) return null
	if (typeof value !== 'object') return null
	const attribution = parseFirstTouchAttribution({ body: value })
	return hasFirstTouchAttribution(attribution) ? attribution : null
}

function isOauthPendingSignup(
	value: unknown,
): value is StoredOauthPendingSignup {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const attributionOk =
		record.attribution === undefined ||
		record.attribution === null ||
		typeof record.attribution === 'object'
	return (
		record.v === 1 &&
		typeof record.provider === 'string' &&
		isOauthProviderId(record.provider) &&
		typeof record.providerUserId === 'string' &&
		record.providerUserId.length > 0 &&
		typeof record.email === 'string' &&
		record.email.length > 0 &&
		(record.providerUsername === null ||
			typeof record.providerUsername === 'string') &&
		(record.displayName === null || typeof record.displayName === 'string') &&
		typeof record.suggestedUsername === 'string' &&
		record.suggestedUsername.length > 0 &&
		(record.redirectTo === null || typeof record.redirectTo === 'string') &&
		attributionOk &&
		typeof record.csrf === 'string' &&
		record.csrf.length > 0 &&
		(record.accessToken === null || typeof record.accessToken === 'string') &&
		typeof record.issuedAt === 'number' &&
		Number.isFinite(record.issuedAt)
	)
}

function normalizePending(value: StoredOauthPendingSignup): OauthPendingSignup {
	return {
		provider: value.provider,
		providerUserId: value.providerUserId,
		email: value.email,
		providerUsername: value.providerUsername,
		displayName: value.displayName,
		suggestedUsername: value.suggestedUsername,
		redirectTo: value.redirectTo,
		attribution: parseAttributionField(value.attribution),
		csrf: value.csrf,
		accessToken: value.accessToken,
		issuedAt: value.issuedAt,
	}
}

export async function createOauthPendingSignupCookie(
	state: OauthPendingSignup,
	secure: boolean,
) {
	const stored: StoredOauthPendingSignup = {
		v: 1,
		...state,
		attribution: parseAttributionField(state.attribution),
	}
	return getPendingCookie().serialize(JSON.stringify(stored), { secure })
}

export async function destroyOauthPendingSignupCookie(secure: boolean) {
	return getPendingCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readOauthPendingSignup(
	request: Request,
): Promise<OauthPendingSignup | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const stored = await getPendingCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		if (!isOauthPendingSignup(parsed)) return null
		const pending = normalizePending(parsed)
		const ageMs = Date.now() - pending.issuedAt
		if (ageMs < 0 || ageMs > oauthPendingSignupMaxAgeSeconds * 1000) {
			return null
		}
		return pending
	} catch {
		return null
	}
}

export const oauthPendingSignupMaxAgeMs = oauthPendingSignupMaxAgeSeconds * 1000
