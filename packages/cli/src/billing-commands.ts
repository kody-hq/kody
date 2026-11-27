/**
 * `kody billing checkout-link`: a thin wrapper for the Open API
 * `billingCheckoutLink` operation. It prints a kody.codes link a person
 * opens to pay; the CLI never starts or completes a payment.
 */
type CallOperation = (
	operationId: string,
	params: Record<string, unknown>,
) => Promise<unknown>

export const billingCheckoutLinkUsage =
	'Usage: kody billing checkout-link [--org <slug>] [--interval month|year] [--json]'

type CheckoutLinkResult =
	| { ok: true; url: string; message: string }
	| { ok: false; reason: string }

export function parseBillingCheckoutLinkCommand(input: {
	positionals: ReadonlyArray<string>
	values: Record<string, unknown>
}): { interval?: string } {
	if (input.positionals.length > 0) throw new Error(billingCheckoutLinkUsage)
	const interval = input.values.interval
	if (interval === undefined) return {}
	if (interval !== 'month' && interval !== 'year') {
		throw new Error(
			`--interval takes month or year (got "${String(interval)}").`,
		)
	}
	return { interval }
}

/** The text to print, and the exit code: 1 when checkout does not apply. */
export async function runBillingCheckoutLink(input: {
	interval?: string
	call: CallOperation
	json: boolean
}): Promise<{ output: string; exitCode: number }> {
	const result = (await input.call('billingCheckoutLink', {
		plan: 'pro',
		...(input.interval ? { interval: input.interval } : {}),
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
