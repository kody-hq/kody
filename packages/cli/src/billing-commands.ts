/**
 * `kody billing checkout-link` and `kody billing manage-link`: thin wrappers
 * for the Open API `billingCheckoutLink` and `billingManageLink` operations.
 * Each prints a kody.codes link a person opens; the CLI never starts or
 * completes a payment.
 */
type CallOperation = (
	operationId: string,
	params: Record<string, unknown>,
) => Promise<unknown>

const billingCheckoutLinkUsage =
	'Usage: kody billing checkout-link [--org <slug>] [--interval month|year] [--promo-code <code>] [--json]'

export const billingManageLinkUsage =
	'Usage: kody billing manage-link [--org <slug>] [--json]'

export const billingUsage = `${billingCheckoutLinkUsage}\n       ${billingManageLinkUsage.slice('Usage: '.length)}`

type CheckoutLinkResult =
	| { ok: true; url: string; message: string }
	| { ok: false; reason: string }

export function parseBillingCheckoutLinkCommand(input: {
	positionals: ReadonlyArray<string>
	values: Record<string, unknown>
}): { interval?: string; promoCode?: string } {
	if (input.positionals.length > 0) throw new Error(billingCheckoutLinkUsage)
	const interval = input.values.interval
	const promoCode = input.values['promo-code']
	if (interval !== undefined && interval !== 'month' && interval !== 'year') {
		throw new Error(
			`--interval takes month or year (got "${String(interval)}"). Pass a promo code with --promo-code.`,
		)
	}
	if (
		promoCode !== undefined &&
		(typeof promoCode !== 'string' || !promoCode)
	) {
		throw new Error('--promo-code takes a code.')
	}
	return {
		...(interval ? { interval } : {}),
		...(promoCode ? { promoCode } : {}),
	}
}

/** The text to print, and the exit code: 1 when checkout does not apply. */
export async function runBillingCheckoutLink(input: {
	interval?: string
	promoCode?: string
	call: CallOperation
	json: boolean
}): Promise<{ output: string; exitCode: number }> {
	const result = (await input.call('billingCheckoutLink', {
		plan: 'pro',
		...(input.interval ? { interval: input.interval } : {}),
		...(input.promoCode ? { promoCode: input.promoCode } : {}),
	})) as CheckoutLinkResult
	const exitCode = result.ok ? 0 : 1
	if (input.json) {
		return { output: `${JSON.stringify(result, null, 2)}\n`, exitCode }
	}
	return {
		output: result.ok
			? `${result.url}\n\n${result.message}\n`
			: `${result.reason}\n`,
		exitCode,
	}
}

/** The billing page link, or the reason there is none (exit code 1). */
export async function runBillingManageLink(input: {
	call: CallOperation
	json: boolean
}): Promise<{ output: string; exitCode: number }> {
	const result = (await input.call('billingManageLink', {})) as
		| { ok: true; url: string; message: string }
		| { ok: false; reason: string }
	const exitCode = result.ok ? 0 : 1
	if (input.json) {
		return { output: `${JSON.stringify(result, null, 2)}\n`, exitCode }
	}
	return {
		output: result.ok
			? `${result.url}\n\n${result.message}\n`
			: `${result.reason}\n`,
		exitCode,
	}
}
