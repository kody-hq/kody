import { buildPackageOwnerErrorSpikeEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import {
	loadOrgOwnerRecipientEmails,
	loadOrgSlug,
	loadOrgUsernameFallback,
} from '#worker/orgs/owner-emails.ts'
import { routes } from '#universal/routes.ts'
import { resolveFleetPackageErrorRateEnvironment } from '#worker/usage/fleet-package-error-rate.ts'
import {
	refreshPackageOwnerErrorSpikes,
	type PackageOwnerErrorSpikeEnv,
	type PackageOwnerSpikeState,
	type PackageOwnerSpikeWindow,
} from '#worker/usage/package-owner-error-spike.ts'
import { buildPackageOwnerErrorSpikeEvent } from '#worker/usage/package-owner-error-spike-subscription-event.ts'
import { dispatchPackageOwnerErrorSpikeSubscriptionEvent } from '#worker/usage/package-owner-error-spike-subscriptions.ts'

export type PackageOwnerErrorSpikeAlertResult = Awaited<
	ReturnType<typeof refreshPackageOwnerErrorSpikes>
>

/**
 * Hourly sweep: evaluate package-owner error spikes, email owners once on
 * ok→alerted, and fan a non-paging admin audit event.
 */
export async function refreshPackageOwnerErrorSpikesAndMaybeAlert(input: {
	env: PackageOwnerErrorSpikeEnv &
		Pick<
			Env,
			| 'CLOUDFLARE_ACCOUNT_ID'
			| 'CLOUDFLARE_API_BASE_URL'
			| 'CLOUDFLARE_API_TOKEN'
		>
	now?: Date
}): Promise<PackageOwnerErrorSpikeAlertResult> {
	const now = input.now ?? new Date()
	return await refreshPackageOwnerErrorSpikes({
		env: input.env,
		now,
		onAlert: async ({ ownerId, window, state }) => {
			await notifyPackageOwnerErrorSpike({
				env: input.env,
				ownerId,
				window,
				state,
				now,
			})
		},
	})
}

async function notifyPackageOwnerErrorSpike(input: {
	env: PackageOwnerErrorSpikeEnv &
		Pick<
			Env,
			| 'CLOUDFLARE_ACCOUNT_ID'
			| 'CLOUDFLARE_API_BASE_URL'
			| 'CLOUDFLARE_API_TOKEN'
		>
	ownerId: string
	window: PackageOwnerSpikeWindow
	state: PackageOwnerSpikeState
	now: Date
}) {
	const db = input.env.APP_DB
	if (!db) return

	const slug =
		(await loadOrgSlug(db, input.ownerId)) ??
		(await loadOrgUsernameFallback(db, input.ownerId))
	const ownerLabel = slug ? `@${slug}` : 'your account'
	const activityPath = slug ? `/@${slug}/-/activity` : '/account/activity'
	const jobsPath = slug ? `/@${slug}/-/jobs` : '/account/jobs'
	const activityUrl = joinAppUrl({ env: input.env, path: activityPath })
	const jobsUrl = joinAppUrl({ env: input.env, path: jobsPath })
	const insightsUrl = joinAppUrl({ env: input.env, path: '/admin/insights' })
	const supportUrl = joinAppUrl({
		env: input.env,
		path: routes.support.href(),
	})
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	const spikeStartedAt = input.state.spike?.startedAt ?? input.now.toISOString()

	if (emailConfig) {
		const recipients = await loadOrgOwnerRecipientEmails(db, input.ownerId)
		const email = buildPackageOwnerErrorSpikeEmail({
			appBaseUrl: emailConfig.appBaseUrl,
			activityUrl,
			jobsUrl,
			supportUrl,
			ownerLabel,
			errorCount: input.window.errors,
			eventCount: input.window.events,
			rate: input.window.rate,
			spikeStartedAt,
			packages: input.window.packages.map((pkg) => ({
				kodyId: pkg.kody_id,
				errors: pkg.errors,
				events: pkg.events,
				rate: pkg.rate,
			})),
			byMetric: input.window.byMetric.map((row) => ({
				metric: row.metric,
				errors: row.errors,
				events: row.events,
			})),
		})
		for (const recipient of recipients) {
			try {
				const sendResult = await sendGatedTransactionalEmail({
					db,
					config: {
						accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
						apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
						apiToken: input.env.CLOUDFLARE_API_TOKEN,
					},
					category: 'holdable',
					kind: 'package_owner_error_spike',
					message: {
						to: recipient.email,
						from: emailConfig.fromEmail,
						subject: email.subject,
						html: email.html,
						text: email.text,
					},
				})
				if (!sendResult.ok) {
					console.warn('package-owner-error-spike-email-skipped', {
						ownerId: input.ownerId,
						reason: sendResult.error ?? 'unconfigured',
					})
				}
			} catch (error) {
				console.warn('package-owner-error-spike-email-failed', {
					ownerId: input.ownerId,
					error,
				})
			}
		}
	}

	const username = slug ?? 'unknown'
	const ownerToken = await shortOwnerToken(input.ownerId)
	await dispatchPackageOwnerErrorSpikeSubscriptionEvent({
		env: input.env as Pick<
			Env,
			'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
		>,
		event: buildPackageOwnerErrorSpikeEvent({
			eventId: `${ownerToken}:${input.window.windowEnd}`,
			insightsUrl,
			activityUrl,
			environment: resolveFleetPackageErrorRateEnvironment(input.env),
			observedAt: input.now.toISOString(),
			ownerUsername: username,
			windowStart: input.window.windowStart,
			windowEnd: input.window.windowEnd,
			events: input.window.events,
			errors: input.window.errors,
			rate: input.window.rate,
			spikeStartedAt,
			packages: input.window.packages,
			byMetric: input.window.byMetric,
		}),
	})

	console.warn('package-owner-error-spike-alerted', {
		owner: username,
		errors: input.window.errors,
		events: input.window.events,
		rate: input.window.rate,
		packages: input.window.packages.map((pkg) => pkg.kody_id),
	})
}

async function shortOwnerToken(ownerId: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(ownerId),
	)
	return Array.from(new Uint8Array(digest))
		.slice(0, 8)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}
