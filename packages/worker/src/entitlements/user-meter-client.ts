import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	BudgetLimitError,
	budgetLimitErrorCode,
	coerceBudgetLimitError,
	type BudgetLimitErrorDetails,
} from './errors.ts'
import type {
	UserMeterBudgetCheckInput,
	UserMeterBudgetCheckResult,
	UserMeterBudgetSpendState,
	UserMeterRpc,
} from './user-meter-do.ts'

export type UserMeterEnv = {
	USER_METER?: DurableObjectNamespace
}

export function userMeterNamespace(
	env: UserMeterEnv,
): DurableObjectNamespace | null {
	return env.USER_METER ?? null
}

/**
 * Typed UserMeter RPC stub; throws when `USER_METER` is missing.
 * `userId` is the durable object name key (org id for team billing; for
 * personal orgs the org id equals the owner user id).
 */
export function userMeterRpc(input: {
	env: UserMeterEnv
	userId: OwnerId
}): UserMeterRpc {
	const namespace = userMeterNamespace(input.env)
	if (!namespace) {
		throw new Error('USER_METER Durable Object binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(userMeterDurableObjectName(input.userId)),
	) as unknown as UserMeterRpc
}

export type { UserMeterRpc }

type UserMeterBudgetCheckRpc = {
	checkBudgetAndRecord: (
		input: UserMeterBudgetCheckInput,
	) => Promise<UserMeterBudgetCheckResult>
	/** Throwing form on UserMeter code deployed before checkBudgetAndRecord. */
	assertWithinBudgetAndRecord: (
		input: UserMeterBudgetCheckInput,
	) => Promise<UserMeterBudgetSpendState>
}

/**
 * The only way to run the UserMeter budget check (lint rule
 * `kody-custom/user-meter-budget-check-via-helper`). Records the delta only
 * when allowed, and throws BudgetLimitError on denial. Fails closed: a
 * malformed or missing result refuses.
 */
export async function checkUserMeterBudgetAndRecord(input: {
	env: UserMeterEnv
	userId: OwnerId
	check: UserMeterBudgetCheckInput
}): Promise<UserMeterBudgetSpendState> {
	const meter = userMeterRpc(input) as unknown as UserMeterBudgetCheckRpc
	let result: unknown
	try {
		result = await meter.checkBudgetAndRecord(input.check)
	} catch (error) {
		throwIfBudgetLimitError(error)
		if (!isMissingRpcMethodError(error)) throw error
		result = await legacyBudgetCheck(meter, input.check)
	}
	return unwrapBudgetCheckResult(result)
}

async function legacyBudgetCheck(
	meter: UserMeterBudgetCheckRpc,
	check: UserMeterBudgetCheckInput,
): Promise<unknown> {
	try {
		const state = await meter.assertWithinBudgetAndRecord(check)
		return { outcome: 'allowed', state }
	} catch (error) {
		throwIfBudgetLimitError(error)
		throw error
	}
}

/** RPC rethrows lose the class, so rebuild the same BudgetLimitError. */
function throwIfBudgetLimitError(error: unknown) {
	const budgetError = coerceBudgetLimitError(error)
	if (budgetError) throw new BudgetLimitError(budgetError.details)
}

function isMissingRpcMethodError(error: unknown) {
	return (
		error instanceof Error &&
		/RPC receiver does not implement/.test(error.message)
	)
}

function unwrapBudgetCheckResult(result: unknown): UserMeterBudgetSpendState {
	if (isRecord(result)) {
		if (result.outcome === 'allowed' && isBudgetSpendState(result.state)) {
			return result.state
		}
		if (
			result.outcome === 'denied' &&
			isBudgetLimitErrorDetails(result.details)
		) {
			throw new BudgetLimitError(result.details)
		}
	}
	throw new Error(
		'UserMeter budget check returned a malformed result; refusing.',
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isBudgetSpendState(
	value: unknown,
): value is UserMeterBudgetSpendState {
	return (
		isRecord(value) &&
		typeof value.month === 'string' &&
		isRecord(value.users) &&
		Object.values(value.users).every(isFiniteNumber) &&
		isFiniteNumber(value.automationMicroUsd)
	)
}

function isBudgetLimitErrorDetails(
	value: unknown,
): value is BudgetLimitErrorDetails {
	return (
		isRecord(value) &&
		value.code === budgetLimitErrorCode &&
		(value.kind === 'user' || value.kind === 'automation') &&
		typeof value.orgSlug === 'string' &&
		(value.actorUsername === undefined ||
			typeof value.actorUsername === 'string') &&
		isFiniteNumber(value.spentMicroUsd) &&
		isFiniteNumber(value.budgetMicroUsd)
	)
}
