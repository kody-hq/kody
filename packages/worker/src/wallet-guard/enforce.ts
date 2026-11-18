import * as Sentry from '@sentry/cloudflare'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { resolveLiveOverriddenLimits } from '#worker/entitlements/service.ts'
import {
	userMeterNamespace,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { isLivePersonRequest } from '#worker/authorization/authorize.ts'
import type {
	WalletGuardAdmission,
	WalletGuardCheck,
	WalletGuardMode,
} from '#worker/entitlements/wallet-guard-windows.ts'
import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import {
	buildWalletGuardLimitMessage,
	walletGuardLimitErrorCode,
	walletGuardLimitFields,
	walletGuards,
	walletGuardSupportEmail,
	walletGuardUserLimit,
	walletGuardWindowMs,
	type WalletGuardLimitErrorDetails,
	type WalletGuardLimitKey,
	type WalletGuardName,
	type WalletGuardScope,
	type WalletGuardWindow,
} from '#universal/wallet-guards.ts'

export class WalletGuardLimitError extends Error {
	readonly details: WalletGuardLimitErrorDetails

	constructor(details: Omit<WalletGuardLimitErrorDetails, 'code' | 'support'>) {
		super(buildWalletGuardLimitMessage(details))
		this.name = 'WalletGuardLimitError'
		this.details = {
			code: walletGuardLimitErrorCode,
			...details,
			support: walletGuardSupportEmail,
		}
	}
}

export function isWalletGuardLimitErrorDetails(
	value: unknown,
): value is WalletGuardLimitErrorDetails {
	return (
		typeof value === 'object' &&
		value !== null &&
		'code' in value &&
		value.code === walletGuardLimitErrorCode
	)
}

/** Also matches the error after a Durable Object or sandbox RPC hop. */
export function isWalletGuardLimitError(
	error: unknown,
): error is WalletGuardLimitError {
	return (
		error instanceof WalletGuardLimitError ||
		(error instanceof Error &&
			'details' in error &&
			isWalletGuardLimitErrorDetails(error.details))
	)
}

export function findWalletGuardLimitError(
	error: unknown,
): WalletGuardLimitError | null {
	return getErrorCauseChain(error).find(isWalletGuardLimitError) ?? null
}

/** Plain-text 429 for transports that are not the JSON API (git smart HTTP). */
export function walletGuardRateLimitedResponse(error: WalletGuardLimitError) {
	return new Response(`${error.message}\n`, {
		status: 429,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'Retry-After': String(error.details.retryAfterSeconds),
		},
	})
}

type GuardCheck = WalletGuardCheck & {
	scope: WalletGuardScope
	limitKey: WalletGuardLimitKey
	window: WalletGuardWindow
}

function bucketFor(scope: string, limitKey: WalletGuardLimitKey) {
	return `${scope}:${limitKey}`
}

/**
 * The person a call counts against: the caller of a signed-in or token
 * request. A job, webhook, or other triggered run keeps its enabler as the
 * actor, but it is automation and counts against the org only.
 */
export function walletGuardActorUserId(
	request: RequestContext | null | undefined,
): string | null {
	return request && isLivePersonRequest(request)
		? (request.actor?.userId ?? null)
		: null
}

type WalletGuardInput = {
	env: Env
	ownerId: OwnerId
	email: string | null | undefined
	/** From {@link walletGuardActorUserId}; null for automation. */
	actorUserId: string | null | undefined
	guard: WalletGuardName
	now?: Date
}

type WalletGuardRefusal = Extract<WalletGuardAdmission, { admitted: false }>

export type PreparedWalletGuard = {
	/** What the meter checks: person windows first, then org windows. */
	checks: Array<WalletGuardCheck>
	/** Log and report a refusal, and build the error to throw for it. */
	refuse: (refusal: WalletGuardRefusal) => WalletGuardLimitError
}

function reportWalletGuardUnavailable(input: WalletGuardInput, error: unknown) {
	console.warn(
		JSON.stringify({
			event: 'wallet_guard_unavailable',
			guard: input.guard,
			orgId: input.ownerId,
			errorMessage: error instanceof Error ? error.message : String(error),
		}),
	)
}

/**
 * Resolve the windows one call counts against, with live limit overrides.
 * Null when there is nothing to count in (no owner, no meter binding) or
 * the limits could not be read: the guard is a cost ceiling, not an access
 * check, so a failure admits the call instead of taking product paths down.
 */
export async function prepareWalletGuard(
	input: WalletGuardInput,
): Promise<PreparedWalletGuard | null> {
	if (!input.ownerId || !userMeterNamespace(input.env)) return null
	let checks: Array<GuardCheck>
	try {
		const limits = await resolveLiveOverriddenLimits({
			db: input.env.APP_DB,
			userId: input.ownerId,
			email: input.email,
			now: input.now,
		})
		checks = walletGuards[input.guard].limits.flatMap(({ key, window }) => {
			const orgLimit = limits[walletGuardLimitFields[key]]
			const org: GuardCheck = {
				bucket: bucketFor('org', key),
				scope: 'org',
				limitKey: key,
				window,
				windowMs: walletGuardWindowMs[window],
				limit: orgLimit,
			}
			if (!input.actorUserId) return [org]
			return [
				{
					...org,
					bucket: bucketFor(`user:${input.actorUserId}`, key),
					scope: 'user' as const,
					limit: walletGuardUserLimit(orgLimit),
				},
				org,
			]
		})
	} catch (error) {
		reportWalletGuardUnavailable(input, error)
		return null
	}
	return {
		checks: checks.map(({ bucket, windowMs, limit }) => ({
			bucket,
			windowMs,
			limit,
		})),
		refuse: (refusal) => {
			const hit =
				checks.find((check) => check.bucket === refusal.bucket) ?? checks[0]!
			const details = {
				guard: input.guard,
				limitKey: hit.limitKey,
				scope: hit.scope,
				window: hit.window,
				windowSeconds: hit.windowMs / 1000,
				limit: refusal.limit,
				retryAfterSeconds: Math.max(1, Math.ceil(refusal.retryAfterMs / 1000)),
			}
			reportWalletGuardHit({
				...details,
				orgId: input.ownerId,
				actorUserId: input.actorUserId ?? null,
			})
			return new WalletGuardLimitError(details)
		},
	}
}

/**
 * Count one call against the org ceilings and, when a person made it, that
 * person's ceilings. Throws {@link WalletGuardLimitError} when any window is
 * full. `mode: 'check'` refuses without counting and `mode: 'record'` counts
 * without refusing, for a caller that only knows afterwards whether the call
 * was real. A failure to reach the meter admits the call.
 */
export async function enforceWalletGuard(
	input: WalletGuardInput & { mode?: WalletGuardMode },
): Promise<void> {
	const prepared = await prepareWalletGuard(input)
	if (!prepared) return
	let admission: WalletGuardAdmission
	try {
		admission = await userMeterRpc({
			env: input.env,
			userId: input.ownerId,
		}).admitWalletGuard({
			nowMs: (input.now ?? new Date()).getTime(),
			checks: prepared.checks,
			...(input.mode ? { mode: input.mode } : {}),
		})
	} catch (error) {
		reportWalletGuardUnavailable(input, error)
		return
	}
	if (!admission.admitted) throw prepared.refuse(admission)
}

/** At most one Sentry event per org, limit, and scope per isolate per minute. */
export const walletGuardSentryEventIntervalMs = 60_000

const lastEventAtByKey = new Map<string, number>()

function reportWalletGuardHit(
	hit: Omit<WalletGuardLimitErrorDetails, 'code' | 'support'> & {
		orgId: string
		actorUserId: string | null
	},
) {
	console.warn(JSON.stringify({ event: 'wallet_guard_limit_hit', ...hit }))
	try {
		// Every hit leaves a breadcrumb; the event is throttled so a caller
		// looping on a full window cannot flood Sentry.
		Sentry.addBreadcrumb({
			category: 'wallet_guard',
			level: 'warning',
			message: `Wallet guard limit hit: ${hit.limitKey} (per ${hit.scope})`,
			data: hit,
		})
		const eventKey = `${hit.orgId}|${hit.limitKey}|${hit.scope}`
		const nowMs = Date.now()
		const lastSentAt = lastEventAtByKey.get(eventKey)
		if (
			lastSentAt !== undefined &&
			nowMs - lastSentAt < walletGuardSentryEventIntervalMs
		) {
			return
		}
		lastEventAtByKey.set(eventKey, nowMs)
		if (lastEventAtByKey.size > 256) {
			const oldest = lastEventAtByKey.keys().next().value
			if (oldest !== undefined) lastEventAtByKey.delete(oldest)
		}
		Sentry.withScope((scope) => {
			scope.setLevel('warning')
			// One issue per limit and scope; the org is a tag, so a noisy org
			// shows up as event volume instead of a pile of issues.
			scope.setFingerprint(['wallet-guard', hit.limitKey, hit.scope])
			scope.setTag('wallet_guard', hit.guard)
			scope.setTag('wallet_guard.limit_key', hit.limitKey)
			scope.setTag('wallet_guard.scope', hit.scope)
			scope.setTag('wallet_guard.org_id', hit.orgId)
			scope.setContext('wallet_guard', hit)
			Sentry.captureMessage(
				`Wallet guard limit hit: ${hit.limitKey} (per ${hit.scope})`,
			)
		})
	} catch (error) {
		console.warn('wallet-guard-report-failed', error)
	}
}
