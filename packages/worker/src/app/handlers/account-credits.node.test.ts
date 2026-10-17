import { expect, test } from 'vitest'
import { creditTopUpSuccessUrl } from '#worker/billing/credit-top-ups.ts'
import { accountCreditsRedirectUrl } from './account-credits.ts'

test('old /account/credits links land on the personal org credits ledger', () => {
	expect(
		accountCreditsRedirectUrl('https://kody.codes/account/credits', 'ada'),
	).toBe('https://kody.codes/@ada/-/credits')
})

test('the redirect keeps pre-move Stripe returns and notice codes', () => {
	expect(
		accountCreditsRedirectUrl(
			'https://kody.codes/account/credits?topup=success&session_id=cs_123',
			'ada',
		),
	).toBe(
		'https://kody.codes/@ada/-/usage?topup=success&session_id=cs_123#credits',
	)
	expect(
		accountCreditsRedirectUrl(
			'https://kody.codes/account/credits?credits=added',
			'ada',
		),
	).toBe('https://kody.codes/@ada/-/credits?credits=added')
})

test('top-up success URL drops the fragment so Stripe can append the session id', () => {
	expect(creditTopUpSuccessUrl('https://kody.codes/@ada/-/usage#credits')).toBe(
		'https://kody.codes/@ada/-/usage?topup=success&session_id={CHECKOUT_SESSION_ID}',
	)
})
