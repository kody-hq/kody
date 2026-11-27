import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	parseBillingCheckoutLinkCommand,
	runBillingCheckoutLink,
	runBillingManageLink,
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

test('billing checkout-link sends an optional promo code', async () => {
	const plan = parseBillingCheckoutLinkCommand({
		positionals: [],
		values: { 'promo-code': 'BLACKFRIDAY-YEARLY' },
	})
	assert.deepEqual(plan, { promoCode: 'BLACKFRIDAY-YEARLY' })
	assert.throws(
		() =>
			parseBillingCheckoutLinkCommand({
				positionals: [],
				values: { interval: 'BLACKFRIDAY-YEARLY' },
			}),
		/Pass a promo code with --promo-code/,
	)
	const api = recorder({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=year',
		message: 'Open this link to check out Pro for @acme.',
	})
	await runBillingCheckoutLink({ ...plan, call: api.call, json: false })
	assert.deepEqual(api.calls, [
		{
			operationId: 'billingCheckoutLink',
			params: { plan: 'pro', promoCode: 'BLACKFRIDAY-YEARLY' },
		},
	])
})

test('billing manage-link prints the billing page, or the reason and exit 1', async () => {
	const api = recorder({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing',
		org: 'acme',
		message: 'Open this link to manage billing for @acme.',
	})
	assert.deepEqual(
		await runBillingManageLink({ call: api.call, json: false }),
		{
			output:
				'https://kody.codes/@acme/-/billing\n\nOpen this link to manage billing for @acme.\n',
			exitCode: 0,
		},
	)
	assert.deepEqual(api.calls, [
		{ operationId: 'billingManageLink', params: {} },
	])
	const refusal = {
		ok: false,
		reason: 'Only owners and billing admins can manage billing for @acme.',
	}
	assert.deepEqual(
		await runBillingManageLink({ call: recorder(refusal).call, json: false }),
		{ output: `${refusal.reason}\n`, exitCode: 1 },
	)
	const json = await runBillingManageLink({
		call: recorder(refusal).call,
		json: true,
	})
	assert.equal(json.exitCode, 1)
	assert.deepEqual(JSON.parse(json.output), refusal)
})
