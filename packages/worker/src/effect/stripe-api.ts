import type { StripeEnv } from '#worker/billing/stripe-client.ts'
import { makeStripeLive, type Stripe } from '#worker/effect/stripe.ts'

/**
 * Builds the Stripe service for an env. Its own module so node tests can
 * swap the Stripe API with `vi.spyOn` (see `test-support/stripe-effect.ts`).
 */
export function makeStripe(env: StripeEnv): Stripe['Service'] {
	return makeStripeLive(env)
}
