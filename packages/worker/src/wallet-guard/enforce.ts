import * as Sentry from '@sentry/cloudflare'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { resolveLiveOverriddenLimits } from '#worker/entitlements/service.ts'
import {
	userMeterNamespace,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import type {
	WalletGuardAdmission,
	WalletGuardCheck,
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
 * Count one call against the org ceilings and, when a person made it, that
 * person's ceilings. Throws {@link WalletGuardLimitError} when any window is
 * full. Automation (jobs, webhooks, email) has no person and counts against
 * the org only. A failure to reach the meter admits the call: the guard is a
 * cost ceiling, not an access check, so it must not take product paths down.
 */
export async function enforceWalletGuard(input: {
	env: Env
	ownerId: OwnerId
	email: string | null | undefined
	actorUserId: string | null | undefined
	guard: WalletGuardName
	now?: Date
}): Promise<void> {
	// No meter binding (a config without Durable Objects): nothing to count in.
	if (!input.ownerId || !userMeterNamespace(input.env)) return
	const now = input.now ?? new Date()
	let checks: Array<GuardCheck>
	let admission: WalletGuardAdmission
	try {
		const limits = await resolveLiveOverriddenLimits({
			db: input.env.APP_DB,
			userId: input.ownerId,
			email: input.email,
			now,
		})
		checks = walletGuards[input.guard].limits.flatMap(({ key, window }) => {
			const orgLimit = limits[walletGuardLimitFields[key]]
			const windowMs = walletGuardWindowMs[window]
			const org: GuardCheck = {
				bucket: bucketFor('org', key),
				scope: 'org',
				limitKey: key,
				window,
				windowMs,
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
		admission = await userMeterRpc({
			env: input.env,
			userId: input.ownerId,
		}).admitWalletGuard({
			nowMs: now.getTime(),
			checks: checks.map(({ bucket, windowMs, limit }) => ({
				bucket,
				windowMs,
				limit,
			})),
		})
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'wallet_guard_unavailable',
				guard: input.guard,
				orgId: input.ownerId,
				errorMessage: error instanceof Error ? error.message : String(error),
			}),
		)
		return
	}
	if (admission.admitted) return
	const refusedBucket = admission.bucket
	const hit = checks.find((check) => check.bucket === refusedBucket)
	if (!hit) return
	const details = {
		guard: input.guard,
		limitKey: hit.limitKey,
		scope: hit.scope,
		window: hit.window,
		windowSeconds: hit.windowMs / 1000,
		limit: admission.limit,
		retryAfterSeconds: Math.max(1, Math.ceil(admission.retryAfterMs / 1000)),
	}
	reportWalletGuardHit({
		...details,
		orgId: input.ownerId,
		actorUserId: input.actorUserId ?? null,
	})
	throw new WalletGuardLimitError(details)
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
