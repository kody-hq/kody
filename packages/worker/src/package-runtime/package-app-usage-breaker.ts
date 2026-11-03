import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	BudgetLimitError,
	ComputeOverageLimitError,
	isBudgetLimitError,
	isComputeOverageLimitError,
	type BudgetLimitErrorDetails,
	type ComputeOverageLimitErrorDetails,
} from '#worker/entitlements/errors.ts'

/**
 * Circuit breaker for the package-app usage check
 * (`assertWithinComputeInclude`), so serving never waits on it.
 *
 * - **Closed** (no deny entry): serve, and run the check after the response
 *   via `waitUntil`. A usage denial at or past the trip threshold opens the
 *   breaker.
 * - **Open**: a KV deny entry per org and visitor (anonymous visitors share
 *   one), because budget denials can be per member. Requests are refused with the stored
 *   denial and read nothing else until `retryAt`.
 * - **Half-open** (`retryAt` passed): one request per isolate runs the check
 *   before serving. Passing closes the breaker (deletes the entry); a denial
 *   re-opens it in this isolate for another cooldown. The probe re-reads the
 *   entitlement uncached before denying, so a credit top-up, a raised budget,
 *   or a new month resumes serving within one cooldown.
 *
 * The trip threshold is `PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT` percent of
 * the limit the check already enforces (default 100: trip exactly when the
 * check denies). The check only denies past the limit, so values below 100
 * behave like 100; values above 100 keep serving through a grace margin.
 *
 * While closed, each isolate runs the check at most once per
 * `asyncCheckIntervalMs` per scope, so a busy app does not pay the check's D1
 * reads on every request; a trip is noticed within that interval.
 *
 * Fails closed: when the deny entry cannot be read, the check runs before
 * serving, as it did before the breaker. KV is written only when the breaker
 * first opens and when a probe closes it, never per request or per failed
 * probe, so a key stays far below the KV one-write-per-second limit even when
 * many isolates probe.
 */

const breakerKeyPrefix = 'package-app-usage-breaker:v1'
export const packageAppUsageBreakerCooldownMs = 10_000
const breakerEntryTtlSeconds = 24 * 60 * 60
const isolateStateTtlMs = 5_000
export const asyncCheckIntervalMs = 5_000
export const defaultPackageAppUsageBreakerLimitPercent = 100
// Per-isolate maps are keyed by visitor, so cap them; clearing only costs a
// re-read of the deny entry and one extra async check.
const maxIsolateScopes = 10_000

type StoredDenial =
	| { kind: 'compute'; details: ComputeOverageLimitErrorDetails }
	| { kind: 'budget'; details: BudgetLimitErrorDetails }

type BreakerEntry = {
	v: 1
	openedAt: number
	retryAt: number
	denial: StoredDenial
}

type BreakerEnv = Pick<
	Env,
	'BUNDLE_ARTIFACTS_KV' | 'PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT'
>

const isolateState = new Map<
	string,
	{ entry: BreakerEntry | null; expiresAt: number }
>()
const probesInFlight = new Set<string>()
const lastAsyncCheckAt = new Map<string, number>()
// Bumped on every local open or close, so a KV read that started earlier
// cannot overwrite the newer state when it resolves.
const scopeGeneration = new Map<string, number>()

/** Clears per-isolate breaker state between tests. */
export function resetPackageAppUsageBreakerForTests() {
	isolateState.clear()
	probesInFlight.clear()
	lastAsyncCheckAt.clear()
	scopeGeneration.clear()
}

function breakerScope(ownerId: OwnerId, actorId: string | null) {
	return `${ownerId}:${actorId ?? '-'}`
}

function limitPercent(env: BreakerEnv) {
	const raw = env.PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT
	const n = typeof raw === 'string' ? Number(raw.trim()) : raw
	return typeof n === 'number' && Number.isFinite(n) && n > 0
		? n
		: defaultPackageAppUsageBreakerLimitPercent
}

function rememberBounded<V>(map: Map<string, V>, key: string, value: V) {
	if (!map.has(key) && map.size >= maxIsolateScopes) map.clear()
	map.set(key, value)
}

function toStoredDenial(error: unknown): StoredDenial | null {
	if (isComputeOverageLimitError(error)) {
		return { kind: 'compute', details: error.details }
	}
	if (isBudgetLimitError(error)) {
		return { kind: 'budget', details: error.details }
	}
	return null
}

function denialError(denial: StoredDenial) {
	switch (denial.kind) {
		case 'compute':
			return new ComputeOverageLimitError(denial.details)
		case 'budget':
			return new BudgetLimitError(denial.details)
		default: {
			const exhaustive: never = denial
			throw new Error(`Unknown usage denial: ${String(exhaustive)}`)
		}
	}
}

/** Usage relative to its limit, in percent; null when the denial has no amounts. */
function usagePercent(denial: StoredDenial) {
	switch (denial.kind) {
		case 'compute':
			return denial.details.limit > 0
				? (denial.details.current / denial.details.limit) * 100
				: null
		case 'budget':
			return denial.details.budgetMicroUsd > 0
				? (denial.details.spentMicroUsd / denial.details.budgetMicroUsd) * 100
				: null
		default: {
			const exhaustive: never = denial
			throw new Error(`Unknown usage denial: ${String(exhaustive)}`)
		}
	}
}

type CheckOutcome =
	| { kind: 'allow' }
	| { kind: 'trip'; denial: StoredDenial; error: unknown }
	| { kind: 'error'; error: unknown }

async function runCheck(
	env: BreakerEnv,
	check: () => Promise<void>,
): Promise<CheckOutcome> {
	try {
		await check()
		return { kind: 'allow' }
	} catch (error) {
		const denial = toStoredDenial(error)
		if (!denial) return { kind: 'error', error }
		const percent = usagePercent(denial)
		if (percent !== null && percent < limitPercent(env)) {
			return { kind: 'allow' }
		}
		return { kind: 'trip', denial, error }
	}
}

function isBreakerEntry(value: unknown): value is BreakerEntry {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const denial = record.denial as Record<string, unknown> | undefined
	return (
		record.v === 1 &&
		typeof record.openedAt === 'number' &&
		typeof record.retryAt === 'number' &&
		(denial?.kind === 'compute' || denial?.kind === 'budget') &&
		typeof denial.details === 'object' &&
		denial.details !== null
	)
}

function setLocalState(
	scope: string,
	state: { entry: BreakerEntry | null; expiresAt: number },
) {
	rememberBounded(scopeGeneration, scope, (scopeGeneration.get(scope) ?? 0) + 1)
	rememberBounded(isolateState, scope, state)
}

async function readEntry(env: BreakerEnv, scope: string, now: number) {
	const cached = isolateState.get(scope)
	if (cached && cached.expiresAt > now) return cached.entry
	const generation = scopeGeneration.get(scope) ?? 0
	const stored = await env.BUNDLE_ARTIFACTS_KV.get(
		`${breakerKeyPrefix}:${scope}`,
		'json',
	)
	const entry = isBreakerEntry(stored) ? stored : null
	if ((scopeGeneration.get(scope) ?? 0) !== generation) {
		const local = isolateState.get(scope)
		return local ? local.entry : entry
	}
	rememberBounded(isolateState, scope, {
		entry,
		expiresAt: now + isolateStateTtlMs,
	})
	return entry
}

function newEntry(denial: StoredDenial, now: number): BreakerEntry {
	return {
		v: 1,
		openedAt: now,
		retryAt: now + packageAppUsageBreakerCooldownMs,
		denial,
	}
}

async function openBreaker(input: {
	env: BreakerEnv
	scope: string
	denial: StoredDenial
	now: number
}) {
	const entry = newEntry(input.denial, input.now)
	setLocalState(input.scope, {
		entry,
		expiresAt: input.now + isolateStateTtlMs,
	})
	console.info('package-app-usage-breaker-open', {
		kind: input.denial.kind,
		retryAt: new Date(entry.retryAt).toISOString(),
	})
	await input.env.BUNDLE_ARTIFACTS_KV.put(
		`${breakerKeyPrefix}:${input.scope}`,
		JSON.stringify(entry),
		{ expirationTtl: breakerEntryTtlSeconds },
	)
}

async function closeBreaker(env: BreakerEnv, scope: string, now: number) {
	setLocalState(scope, { entry: null, expiresAt: now + isolateStateTtlMs })
	console.info('package-app-usage-breaker-closed')
	await env.BUNDLE_ARTIFACTS_KV.delete(`${breakerKeyPrefix}:${scope}`)
}

async function checkAfterResponse(input: {
	env: BreakerEnv
	scope: string
	check: () => Promise<void>
	clock: () => number
}) {
	const outcome = await runCheck(input.env, input.check)
	const now = input.clock()
	switch (outcome.kind) {
		case 'allow':
			return
		case 'trip': {
			// Another request in this isolate may have tripped it already.
			const cached = isolateState.get(input.scope)?.entry
			if (cached && now < cached.retryAt) return
			await openBreaker({
				env: input.env,
				scope: input.scope,
				denial: outcome.denial,
				now,
			})
			return
		}
		case 'error':
			console.warn('package-app-usage-check-failed', outcome.error)
			return
		default: {
			const exhaustive: never = outcome
			throw new Error(`Unknown usage outcome: ${String(exhaustive)}`)
		}
	}
}

async function probe(input: {
	env: BreakerEnv
	scope: string
	check: () => Promise<void>
	now: number
}) {
	const outcome = await runCheck(input.env, input.check)
	switch (outcome.kind) {
		case 'allow':
			await closeBreaker(input.env, input.scope, input.now).catch(
				(error: unknown) => {
					console.warn('package-app-usage-breaker-close-failed', error)
				},
			)
			return
		case 'trip': {
			// Re-open in this isolate only: the KV entry already refuses other
			// isolates until they probe, and skipping the write keeps concurrent
			// probes from hammering one key.
			const entry = newEntry(outcome.denial, input.now)
			setLocalState(input.scope, { entry, expiresAt: entry.retryAt })
			throw outcome.error
		}
		case 'error':
			throw outcome.error
		default: {
			const exhaustive: never = outcome
			throw new Error(`Unknown usage outcome: ${String(exhaustive)}`)
		}
	}
}

/**
 * Gate one package-app request on the org's usage. Resolves to serve; throws
 * the stored usage denial (or a storage error) to refuse.
 */
export async function gatePackageAppUsage(input: {
	env: BreakerEnv
	ownerId: OwnerId
	/** Visitor person id, or null for an anonymous visitor. */
	actorId: string | null
	/** The usage check; throws a usage denial when the org is over its limit. */
	check: () => Promise<void>
	waitUntil: (promise: Promise<unknown>) => void
	now?: number
}): Promise<void> {
	const clock = () => input.now ?? Date.now()
	const now = clock()
	const scope = breakerScope(input.ownerId, input.actorId)
	let entry: BreakerEntry | null
	try {
		entry = await readEntry(input.env, scope, now)
	} catch (error) {
		console.warn('package-app-usage-breaker-read-failed', error)
		const outcome = await runCheck(input.env, input.check)
		if (outcome.kind === 'allow') return
		throw outcome.error
	}

	if (!entry) {
		const last = lastAsyncCheckAt.get(scope)
		if (last !== undefined && now - last < asyncCheckIntervalMs) return
		rememberBounded(lastAsyncCheckAt, scope, now)
		input.waitUntil(
			checkAfterResponse({
				env: input.env,
				scope,
				check: input.check,
				clock,
			}).catch((error: unknown) => {
				console.warn('package-app-usage-breaker-write-failed', error)
			}),
		)
		return
	}
	if (now < entry.retryAt || probesInFlight.has(scope)) {
		throw denialError(entry.denial)
	}
	probesInFlight.add(scope)
	try {
		await probe({ env: input.env, scope, check: input.check, now })
	} finally {
		probesInFlight.delete(scope)
	}
}
