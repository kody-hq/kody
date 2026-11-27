import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	parseBillingCheckoutLinkCommand,
	runBillingCheckoutLink,
} from '../src/billing-commands.js'

function recorder(result: unknown) {
	const calls: Array<{ operationId: string; params: Record<string, unknown> }> =
		[]
	return {
		calls,
		call: async (operationId: string, params: Record<string, unknown>) => {
			calls.push({ operationId, params })
			return result
		},
	}
}

test('billing checkout-link parses the interval and rejects extras', () => {
	assert.deepEqual(
		parseBillingCheckoutLinkCommand({ positionals: [], values: {} }),
		{},
	)
	assert.deepEqual(
		parseBillingCheckoutLinkCommand({
			positionals: [],
			values: { interval: 'year' },
		}),
		{ interval: 'year' },
	)
	assert.throws(
		() =>
			parseBillingCheckoutLinkCommand({
				positionals: [],
				values: { interval: 'weekly' },
			}),
		/--interval takes month or year \(got "weekly"\)/,
	)
	assert.throws(
		() => parseBillingCheckoutLinkCommand({ positionals: ['pro'], values: {} }),
		/Usage: kody billing checkout-link/,
	)
})

test('billing checkout-link prints the link and what to tell the person', async () => {
	const api = recorder({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=year',
		message: 'Open this link to check out Pro for @acme.',
	})
	const result = await runBillingCheckoutLink({
		interval: 'year',
		call: api.call,
		json: false,
	})
	assert.deepEqual(api.calls, [
		{
			operationId: 'billingCheckoutLink',
			params: { plan: 'pro', interval: 'year' },
		},
	])
	assert.deepEqual(result, {
		output:
			'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=year\n\nOpen this link to check out Pro for @acme.\n',
		exitCode: 0,
	})
})

test('billing checkout-link prints the reason and exits 1 when checkout does not apply', async () => {
	const refusal = {
		ok: false,
		reason: '@acme already has a paid plan, so there is nothing to check out.',
	}
	assert.deepEqual(
		await runBillingCheckoutLink({ call: recorder(refusal).call, json: false }),
		{ output: `${refusal.reason}\n`, exitCode: 1 },
	)
	const json = await runBillingCheckoutLink({
		call: recorder(refusal).call,
		json: true,
	})
	assert.equal(json.exitCode, 1)
	assert.deepEqual(JSON.parse(json.output), refusal)
})
