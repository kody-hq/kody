import { env } from 'cloudflare:workers'
import { getEnv } from '#app/env.ts'
import { applyReferralCookie } from '#app/referral-cookie-middleware.ts'
import { withProtocolAccountWriteLease } from '#app/account-write-lease-middleware.ts'

/** Document/protocol policies. Native server functions authorize their own writes. */
export async function applyDocumentPolicies<T extends { response: Response }>(
	request: Request,
	next: () => Promise<T>,
): Promise<T | Response> {
	const bindings = getEnv(env)
	const result = await withProtocolAccountWriteLease(request, bindings, () =>
		next(),
	)
	if (result instanceof Response) return applyReferralCookie(request, result)
	return { ...result, response: applyReferralCookie(request, result.response) }
}
