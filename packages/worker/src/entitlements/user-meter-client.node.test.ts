import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { BudgetLimitError } from './errors.ts'
import { checkUserMeterBudgetAndRecord } from './user-meter-client.ts'

const check = {
	month: '2026-03',
	actorUserId: 'person-1',
	automationSource: null,
	deltaMicroUsd: 1,
	userBudgetMicroUsd: 1_000_000,
	automationBudgetMicroUsd: null,
	actorUsername: 'sam',
	orgSlug: 'acme',
}
const state = {
	month: '2026-03',
	users: { 'person-1': 1 },
	automationMicroUsd: 0,
}
const details = {
	code: 'org_budget_limit_exceeded',
	kind: 'user',
	orgSlug: 'acme',
	actorUsername: 'sam',
	spentMicroUsd: 1_000_000,
	budgetMicroUsd: 1_000_000,
} as const
const message =
	'@sam reached their monthly budget in org @acme ($1.00 of $1.00). An org Owner or Billing member can raise it.'

function run(stub: Record<string, unknown>) {
	const env = {
		USER_METER: {
			idFromName: (name: string) => name,
			get: () => stub,
		} as unknown as DurableObjectNamespace,
	}
	return checkUserMeterBudgetAndRecord({
		env,
		userId: ownerIdFromStored('org-1'),
		check,
	})
}

/** An RPC-thrown error keeps name, message, and own properties, not the class. */
function rpcBudgetError() {
	const error = new Error(message) as Error & { details: unknown }
	error.name = 'BudgetLimitError'
	error.details = details
	return error
}

const missingMethod = () =>
	Promise.reject(
		new TypeError(
			'The RPC receiver does not implement the method "checkBudgetAndRecord".',
		),
	)

test('allowed returns the recorded spend state', async () => {
	const checkBudgetAndRecord = vi.fn(async () => ({
		outcome: 'allowed',
		state,
	}))
	await expect(run({ checkBudgetAndRecord })).resolves.toEqual(state)
	expect(checkBudgetAndRecord).toHaveBeenCalledWith(check)
})

test('a denial throws the same BudgetLimitError as the old thrown form', async () => {
	const error = await run({
		checkBudgetAndRecord: async () => ({ outcome: 'denied', details }),
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(BudgetLimitError)
	expect(error).toEqual(new BudgetLimitError(details))
	expect((error as BudgetLimitError).message).toBe(message)
	expect((error as BudgetLimitError).details).toEqual(details)
})

test('a malformed or missing result refuses instead of allowing', async () => {
	const malformed = [
		undefined,
		null,
		state,
		{ outcome: 'allowed' },
		{ outcome: 'allowed', state: { month: '2026-03' } },
		{ outcome: 'denied' },
		{ outcome: 'denied', details: { ...details, code: 'other' } },
		{ outcome: 'denied', details: { ...details, kind: 'team' } },
		{ outcome: 'denied', details: { ...details, spentMicroUsd: '1' } },
		{ outcome: 'ok', state },
	]
	for (const result of malformed) {
		await expect(
			run({ checkBudgetAndRecord: async () => result }),
		).rejects.toThrow(
			'UserMeter budget check returned a malformed result; refusing.',
		)
	}
})

test('a BudgetLimitError thrown by an old UserMeter refuses like a denial', async () => {
	const thrown = await run({
		checkBudgetAndRecord: () => Promise.reject(rpcBudgetError()),
	}).catch((caught: unknown) => caught)
	expect(thrown).toEqual(new BudgetLimitError(details))

	const legacy = await run({
		checkBudgetAndRecord: missingMethod,
		assertWithinBudgetAndRecord: () => Promise.reject(rpcBudgetError()),
	}).catch((caught: unknown) => caught)
	expect(legacy).toBeInstanceOf(BudgetLimitError)
	expect(legacy).toEqual(new BudgetLimitError(details))
})

test('an old UserMeter without the typed method falls back to the throwing form', async () => {
	const assertWithinBudgetAndRecord = vi.fn(async () => state)
	await expect(
		run({ checkBudgetAndRecord: missingMethod, assertWithinBudgetAndRecord }),
	).resolves.toEqual(state)
	expect(assertWithinBudgetAndRecord).toHaveBeenCalledWith(check)

	await expect(
		run({
			checkBudgetAndRecord: missingMethod,
			assertWithinBudgetAndRecord: async () => undefined,
		}),
	).rejects.toThrow('malformed result; refusing')
})

test('other meter failures propagate', async () => {
	await expect(
		run({
			checkBudgetAndRecord: () => Promise.reject(new Error('meter down')),
		}),
	).rejects.toThrow('meter down')
})
