import { isSecureRequest } from '#app/auth-session.ts'
import { serializeReferralCookie } from '#universal/referral-cookie.ts'
import { parseReferralCode } from '#universal/referral-program.ts'

/**
 * Last-wins `kody_ref` cookie. Any request with a valid `?ref=` / `?referral=`
 * overwrites the previous referrer and refreshes the one-week expiry.
 * Responses that set the cookie are `no-store` so a personalized Set-Cookie
 * cannot enter the anonymous HTML cache.
 */
export function applyReferralCookie(
	request: Request,
	response: Response,
): Response {
	const url = new URL(request.url)
	const code = parseReferralCode({ searchParams: url.searchParams })
	if (!code) return response
	const headers = new Headers(response.headers)
	headers.append(
		'Set-Cookie',
		serializeReferralCookie({
			code,
			secure: isSecureRequest(request),
		}),
	)
	headers.set('Cache-Control', 'no-store')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
