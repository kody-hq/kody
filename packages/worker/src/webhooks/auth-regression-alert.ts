import * as Sentry from '@sentry/cloudflare'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	listWebhookOwners,
	mapWithConcurrency,
	readWebhookDeliveries,
	webhookOwnerScanConcurrency,
	type WebhookDelivery,
	type WebhookOwner,
} from './delivery-outcomes.ts'

/**
 * Hourly check for a webhook that was delivering and now only gets 401s,
 * the signature a platform auth change leaves (for example a new signature
 * requirement its sender cannot meet). Each regression is its own Sentry
 * issue, fingerprinted by endpoint, with a per-endpoint cooldown.
 */
export const webhookAuthRegressionRecentWindowMinutes = 60
export const webhookAuthRegressionLookbackDays = 7
export const webhookAuthRegressionMinStreak = 3
export const webhookAuthRegressionCooldownMinutes = 24 * 60
export const webhookAuthRegressionKvKeyPrefix =
	'ops-alert:webhook-auth-regression:v1:'

export type WebhookAuthRegression = {
	ownerId: OwnerId
	ownerSlug: string | null
	endpointKey: string
	endpointId: string | null
	packageId: string | null
	packageKodyId: string | null
	webhookName: string | null
	/** Consecutive 401 deliveries since the last success. */
	unauthorizedStreak: number
	errors: Record<string, number>
	lastDeliveredAt: string
	firstUnauthorizedAt: string
	lastUnauthorizedAt: string
}

export type WebhookAuthRegressionResult = {
	ownersScanned: number
	ownersFailed: number
	candidates: number
	regressions: Array<WebhookAuthRegression>
	alerted: number
	cooldown: number
}

/**
 * Newest-first deliveries of one endpoint: a regression is a run of at least
 * `minStreak` 401s that ends at a success. Any other outcome inside the run
 * (a 404, 409, or failed export) is not an auth regression.
 */
export function classifyWebhookAuthRegression(input: {
	owner: WebhookOwner
	deliveries: ReadonlyArray<WebhookDelivery>
	minStreak: number
}): WebhookAuthRegression | null {
	const errors: Record<string, number> = {}
	let streak = 0
	let firstUnauthorizedAt: string | null = null
	let lastUnauthorizedAt: string | null = null
	for (const delivery of input.deliveries) {
		if (delivery.delivered) {
			if (streak < input.minStreak || !firstUnauthorizedAt) return null
			return {
				ownerId: input.owner.ownerId,
				ownerSlug: input.owner.slug,
				endpointKey: delivery.endpointKey,
				endpointId: delivery.endpointId,
				packageId: delivery.packageId,
				packageKodyId: delivery.kodyId,
				webhookName: delivery.webhookName,
				unauthorizedStreak: streak,
				errors,
				lastDeliveredAt: delivery.startedAt,
				firstUnauthorizedAt,
				lastUnauthorizedAt: lastUnauthorizedAt ?? firstUnauthorizedAt,
			}
		}
		if (delivery.httpStatus !== 401) return null
		streak += 1
		lastUnauthorizedAt ??= delivery.startedAt
		firstUnauthorizedAt = delivery.startedAt
		const code = delivery.error ?? 'unknown'
		errors[code] = (errors[code] ?? 0) + 1
	}
	return null
}

export async function checkWebhookAuthRegressionsAndAlert(input: {
	env: Env
	now?: Date
	minStreak?: number
	cooldownMinutes?: number
}): Promise<WebhookAuthRegressionResult> {
	const now = input.now ?? new Date()
	const minStreak = input.minStreak ?? webhookAuthRegressionMinStreak
	const cooldownMinutes =
		input.cooldownMinutes ?? webhookAuthRegressionCooldownMinutes
	const recentSince = new Date(
		now.getTime() - webhookAuthRegressionRecentWindowMinutes * 60_000,
	).toISOString()
	const lookbackSince = new Date(
		now.getTime() - webhookAuthRegressionLookbackDays * 24 * 60 * 60_000,
	).toISOString()

	const owners = await listWebhookOwners({
		db: input.env.APP_DB,
		scope: 'live',
	})
	let ownersFailed = 0
	let candidates = 0
	const perOwner = await mapWithConcurrency(
		owners,
		webhookOwnerScanConcurrency,
		async (owner) => {
			try {
				const recent = await readWebhookDeliveries({
					env: input.env,
					ownerId: owner.ownerId,
					filter: { status: 'error', since: recentSince },
				})
				const unauthorized = new Map<string, WebhookDelivery>()
				for (const delivery of recent.deliveries) {
					if (delivery.httpStatus === 401) {
						unauthorized.set(delivery.endpointKey, delivery)
					}
				}
				candidates += unauthorized.size
				const found: Array<WebhookAuthRegression> = []
				for (const sample of unauthorized.values()) {
					// RunLog filters by package and name only; a reminted webhook
					// shares both with the endpoint it replaced.
					const isSameEndpoint = (delivery: WebhookDelivery) =>
						delivery.endpointKey === sample.endpointKey
					const history = await readWebhookDeliveries({
						env: input.env,
						ownerId: owner.ownerId,
						filter: {
							since: lookbackSince,
							packageId: sample.packageId,
							name: sample.webhookName,
						},
						stopWhen: (delivery) =>
							isSameEndpoint(delivery) &&
							(delivery.delivered || delivery.httpStatus !== 401),
					})
					const regression = classifyWebhookAuthRegression({
						owner,
						deliveries: history.deliveries.filter(isSameEndpoint),
						minStreak,
					})
					if (regression) found.push(regression)
				}
				return found
			} catch (error) {
				ownersFailed += 1
				console.warn('webhook-auth-regression-owner-failed', {
					ownerId: owner.ownerId,
					error,
				})
				return []
			}
		},
	)
	const regressions = perOwner.flat()

	let alerted = 0
	let cooldown = 0
	for (const regression of regressions) {
		const kvKey = `${webhookAuthRegressionKvKeyPrefix}${regression.endpointKey}`
		if (await isOnCooldown({ env: input.env, kvKey, now, cooldownMinutes })) {
			cooldown += 1
			continue
		}
		reportWebhookAuthRegression(regression)
		alerted += 1
		await input.env.BUNDLE_ARTIFACTS_KV?.put(kvKey, String(now.getTime()), {
			expirationTtl: (cooldownMinutes + 60) * 60,
		})
	}

	return {
		ownersScanned: owners.length,
		ownersFailed,
		candidates,
		regressions,
		alerted,
		cooldown,
	}
}

function reportWebhookAuthRegression(regression: WebhookAuthRegression) {
	const label = `${regression.ownerSlug ?? regression.ownerId}/${regression.packageKodyId ?? regression.packageId ?? '?'}/${regression.webhookName ?? '?'}`
	console.warn('webhook-auth-regression-alerted', { label, ...regression })
	Sentry.withScope((scope) => {
		scope.setLevel('warning')
		scope.setFingerprint(['webhook-auth-regression', regression.endpointKey])
		scope.setTag('webhook.auth_regression', 'true')
		scope.setTag('webhook.owner', regression.ownerSlug ?? regression.ownerId)
		scope.setContext('webhook_auth_regression', regression)
		Sentry.captureMessage(
			`Webhook ${label} went from successes to ${String(regression.unauthorizedStreak)} straight 401s (${Object.keys(regression.errors).join(', ')})`,
		)
	})
}

async function isOnCooldown(input: {
	env: Env
	kvKey: string
	now: Date
	cooldownMinutes: number
}) {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return false
	try {
		const lastSentMs = Number(await kv.get(input.kvKey))
		return (
			Number.isFinite(lastSentMs) &&
			lastSentMs > 0 &&
			input.now.getTime() - lastSentMs < input.cooldownMinutes * 60_000
		)
	} catch (error) {
		console.debug('webhook-auth-regression-cooldown-read-failed', error)
		return false
	}
}
