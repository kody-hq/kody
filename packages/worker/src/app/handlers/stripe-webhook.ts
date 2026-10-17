import { jsonResponse } from '#worker/json-response.ts'
import { handleStripeWebhookRequest } from '#worker/billing/stripe-webhooks.ts'

/**
 * Unauthenticated Stripe platform-billing webhook ingress.
 * Signature verification requires the raw request body.
 */
export function createStripeWebhookHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		if (request.method !== 'POST') {
			return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
		}
		const result = await handleStripeWebhookRequest({ env, request })
		return jsonResponse(result.body, result.status)
	}
}
