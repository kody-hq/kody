import { reconcileSecondAgentStandardGifts } from '#worker/entitlements/second-agent-gift-reconciliation.ts'
import * as Sentry from '@sentry/cloudflare'
import { checkAuthDenialBurstAndNotify } from '#app/auth-denial-alerts.ts'
import { checkEmailDeliveryBurstAndNotify } from '#app/email-delivery-alerts.ts'
import { checkEmailVerificationStallsAndNotify } from '#app/email-verification-stall-alerts.ts'
import { refreshFleetPackageErrorRateAndMaybeAlert } from '#app/fleet-package-error-rate-alerts.ts'
import { refreshPackageOwnerErrorSpikesAndMaybeAlert } from '#app/package-owner-error-spike-alerts.ts'
import { pruneRetention } from '#app/retention.ts'
import { pruneUnverifiedAccounts } from '#worker/account/unverified-account-purge.ts'
import { pruneSoftDeleted } from '#worker/orgs/purge.ts'
import { reconcileKitSubscribers } from '#worker/kit/subscriber-sync.ts'
import { sendUserEntitlementWarningEmails } from '#worker/entitlements/user-entitlement-warning-emails.ts'
import { sendUserErrorRateEmails } from '#app/user-error-rate-emails.ts'
import { sendUserUsageCampaignEmails } from '#app/user-usage-campaign-emails.ts'
import { emitFleetEntitlementCrossingEvents } from '#app/usage-entitlement-alerts.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import {
	runDrExportTick,
	runDrExportWatchdogTick,
} from '#worker/dr/exporter.ts'
import { sweepStaleInboundDeliveries } from '#worker/email/reconcile-inbound-deliveries.ts'
import { pruneSystemEmailRetention } from '#worker/email/system-email.ts'
import { reconcileD1StorageBytes } from '#worker/entitlements/d1-storage-reconciliation.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { reconcileArtifactsPushes } from '#worker/jobs/reconcile-artifacts-pushes.ts'
import { cleanupRepoSessionBranches } from '#worker/repo/repo-session-cleanup.ts'
import { backfillCommunityListingsBehindPublished } from '#worker/community/listing-behind-backfill.ts'
import { backfillStorageBucketEstimates } from '#worker/storage-buckets/estimate-backfill.ts'
import { refreshAdminInsightsRunLogSnapshot } from '#worker/admin/insights-runlog-snapshot.ts'
import { aggregateUsageRollups } from '#worker/usage/aggregate-rollups.ts'
import { aggregateConnectionUsageDaily } from '#worker/usage/connection-usage-rollup.ts'
import { aggregateCreditAttributionDaily } from '#worker/usage/credit-attribution.ts'
import { runDurableObjectDurationAttribution } from '#worker/usage/durable-object-duration-attribution.ts'
import { runCreditDebits } from '#worker/billing/credit-debits.ts'
import { drainOrgAuditOutbox } from '#worker/orgs/org-audit-outbox.ts'
import { checkWebhookAuthRegressionsAndAlert } from '#worker/webhooks/auth-regression-alert.ts'
import { reconcilePackageAppCustomHostnames } from '#worker/package-app-custom-hostnames/reconcile.ts'
import { runFollowMaintenance } from '#worker/follow/maintenance.ts'
import { checkDlqDepthAndAlert } from './dlq-depth-alert.ts'

export {
	isScheduledLaneName,
	parseScheduledLaneMessage,
	scheduledLaneNames,
	type ScheduledLaneMessage,
	type ScheduledLaneName,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import {
	isJobsWorkerLocalLane,
	type ScheduledLaneMessage,
	type ScheduledLaneName,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'

/**
 * Execute one platform scheduled lane in the main worker. The cron trigger
 * and the scheduled dispatch queue live in the jobs worker (ADR 0016), which
 * forwards every lane it does not own through `JobsHost.runScheduledLane`.
 * Lanes the jobs worker executes locally (job scheduling watchdog) never
 * arrive here.
 */
export async function runScheduledLane(input: {
	env: Env
	lane: ScheduledLaneName
	scheduledAt: Date
}): Promise<unknown> {
	const baseUrl = input.env.APP_BASE_URL ?? 'https://kody.local'
	if (isJobsWorkerLocalLane(input.lane)) {
		throw new Error(
			`Scheduled lane "${input.lane}" is owned by the jobs worker and cannot run in the main worker.`,
		)
	}
	switch (input.lane) {
		case 'reconcile_artifacts_pushes':
			return reconcileArtifactsPushes({
				env: input.env,
				baseUrl,
				now: input.scheduledAt,
			})
		case 'repo_session_cleanup':
			return cleanupRepoSessionBranches({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'reconcile_inbound_deliveries':
			return sweepStaleInboundDeliveries({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'system_email_retention':
			return pruneSystemEmailRetention({
				db: input.env.APP_DB,
				blobs: input.env.EMAIL_BLOBS,
				now: input.scheduledAt,
			})
		case 'storage_bucket_estimate_backfill':
			return backfillStorageBucketEstimates({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'community_listing_behind_backfill':
			return backfillCommunityListingsBehindPublished({
				env: input.env,
			})
		case 'd1_storage_reconciliation':
			return reconcileD1StorageBytes({
				db: input.env.APP_DB,
				env: input.env,
				jobs: jobsData(input.env),
				now: input.scheduledAt,
			})
		case 'second_agent_gift_reconciliation':
			return reconcileSecondAgentStandardGifts({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'oauth_purge_expired': {
			const id = input.env.OAUTH_PURGE_COORDINATOR.idFromName('global')
			const stub = input.env.OAUTH_PURGE_COORDINATOR.get(id)
			return stub.run({ scheduledAt: input.scheduledAt.getTime() })
		}
		case 'org_audit_outbox':
			return drainOrgAuditOutbox({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'package_app_custom_hostnames_reconcile':
			return reconcilePackageAppCustomHostnames({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'follow_maintenance':
			return runFollowMaintenance({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'retention':
			return pruneRetention({ env: input.env, now: input.scheduledAt })
		case 'unverified_account_purge':
			return pruneUnverifiedAccounts({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'soft_delete_purge':
			return pruneSoftDeleted({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'usage_aggregation': {
			const result = await aggregateUsageRollups(input.env, input.scheduledAt)
			try {
				await aggregateCreditAttributionDaily(input.env, input.scheduledAt)
			} catch (error) {
				console.warn('credit-attribution-aggregation-failed', error)
			}
			try {
				await aggregateConnectionUsageDaily(input.env, input.scheduledAt)
			} catch (error) {
				console.warn('connection-usage-aggregation-failed', error)
			}
			let fleetPackageErrorRate: Awaited<
				ReturnType<typeof refreshFleetPackageErrorRateAndMaybeAlert>
			>
			try {
				fleetPackageErrorRate = await refreshFleetPackageErrorRateAndMaybeAlert(
					{
						env: input.env,
						now: input.scheduledAt,
					},
				)
			} catch (error) {
				console.warn('fleet-package-error-rate-lane-failed', error)
				fleetPackageErrorRate = {
					status: 'skipped',
					reason: 'query_failed',
				}
			}
			let packageOwnerErrorSpike: Awaited<
				ReturnType<typeof refreshPackageOwnerErrorSpikesAndMaybeAlert>
			>
			try {
				packageOwnerErrorSpike =
					await refreshPackageOwnerErrorSpikesAndMaybeAlert({
						env: input.env,
						now: input.scheduledAt,
					})
			} catch (error) {
				console.warn('package-owner-error-spike-lane-failed', error)
				packageOwnerErrorSpike = {
					status: 'skipped',
					reason: 'query_failed',
				}
			}
			let runLogSnapshot: { status: 'ok' | 'failed' }
			try {
				await refreshAdminInsightsRunLogSnapshot({
					env: input.env,
					now: input.scheduledAt,
				})
				runLogSnapshot = { status: 'ok' }
			} catch (error) {
				console.warn('admin-insights-run-log-snapshot-lane-failed', error)
				runLogSnapshot = { status: 'failed' }
			}
			// Credits debit only right after a successful recompute, so they
			// never read rollups older than this hour.
			let creditDebits:
				| Awaited<ReturnType<typeof runCreditDebits>>
				| { status: 'failed' }
			try {
				creditDebits = await runCreditDebits({
					env: input.env,
					now: input.scheduledAt,
				})
			} catch (error) {
				console.warn('credit-debits-lane-failed', error)
				creditDebits = { status: 'failed' }
			}
			return {
				...result,
				fleetPackageErrorRate,
				packageOwnerErrorSpike,
				runLogSnapshot,
				creditDebits,
			}
		}
		case 'durable_object_duration_attribution':
			return runDurableObjectDurationAttribution({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'auth_denial_alert': {
			// Settled first so an audit-database failure still fails the lane
			// without skipping the webhook check.
			const [authDenials] = await Promise.allSettled([
				checkAuthDenialBurstAndNotify({
					env: input.env,
					now: input.scheduledAt,
				}),
			])
			let webhookAuthRegressions:
				| Awaited<ReturnType<typeof checkWebhookAuthRegressionsAndAlert>>
				| { status: 'failed' }
			try {
				webhookAuthRegressions = await checkWebhookAuthRegressionsAndAlert({
					env: input.env,
					now: input.scheduledAt,
				})
			} catch (error) {
				console.warn('webhook-auth-regression-lane-failed', error)
				webhookAuthRegressions = { status: 'failed' }
			}
			if (authDenials.status === 'rejected') throw authDenials.reason
			return { ...authDenials.value, webhookAuthRegressions }
		}
		case 'email_delivery_alert':
			return checkEmailDeliveryBurstAndNotify({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'email_verification_stall_alert':
			return checkEmailVerificationStallsAndNotify({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'usage_entitlement_alert': {
			let userWarnings:
				| Awaited<ReturnType<typeof sendUserEntitlementWarningEmails>>
				| { status: 'failed' }
			try {
				userWarnings = await sendUserEntitlementWarningEmails({
					env: input.env,
					now: input.scheduledAt,
				})
			} catch (error) {
				console.warn('user-entitlement-warning-emails-failed', error)
				userWarnings = { status: 'failed' }
			}
			let errorRateEmails:
				| Awaited<ReturnType<typeof sendUserErrorRateEmails>>
				| { status: 'failed' }
			try {
				errorRateEmails = await sendUserErrorRateEmails({
					env: input.env,
					now: input.scheduledAt,
				})
			} catch (error) {
				console.warn('user-error-rate-emails-failed', error)
				errorRateEmails = { status: 'failed' }
			}
			let usageCampaign:
				| Awaited<ReturnType<typeof sendUserUsageCampaignEmails>>
				| { status: 'failed' }
			try {
				usageCampaign = await sendUserUsageCampaignEmails({
					env: input.env,
					now: input.scheduledAt,
				})
			} catch (error) {
				console.warn('user-usage-campaign-emails-failed', error)
				usageCampaign = { status: 'failed' }
			}
			const ops = await emitFleetEntitlementCrossingEvents({
				env: input.env,
				now: input.scheduledAt,
			})
			return { ...ops, userWarnings, errorRateEmails, usageCampaign }
		}
		case 'kit_subscriber_sync': {
			try {
				return await reconcileKitSubscribers({
					env: input.env,
					now: input.scheduledAt,
				})
			} catch (error) {
				console.warn('kit-subscriber-sync-failed', error)
				return { status: 'failed' }
			}
		}
		// DR export lanes are dispatched on cadence by the jobs worker without
		// access to DR configuration; both ticks exit cheaply with a
		// `not-configured` result when DR export is disabled.
		case 'dr_export':
			return runDrExportTick({ env: input.env, now: input.scheduledAt })
		case 'dr_export_watchdog':
			return runDrExportWatchdogTick({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'dlq_depth_alert':
			return checkDlqDepthAndAlert({
				env: input.env,
				now: input.scheduledAt,
			})
		default: {
			const exhaustive: never = input.lane
			throw new Error(`Unhandled scheduled lane: ${String(exhaustive)}`)
		}
	}
}

export async function runScheduledLaneWithFailureIsolation(input: {
	env: Env
	message: ScheduledLaneMessage
}): Promise<'completed' | 'd1_lock_contention' | 'failed'> {
	const scheduledAt = new Date(input.message.scheduledTime)
	try {
		await runScheduledLane({
			env: input.env,
			lane: input.message.lane,
			scheduledAt,
		})
		return 'completed'
	} catch (error) {
		if (isRetryableD1LockError(error)) {
			console.warn(
				`scheduled_lane_d1_lock_contention lane=${input.message.lane}`,
				error,
			)
			return 'd1_lock_contention'
		}
		console.error(`scheduled_lane_failed lane=${input.message.lane}`, error)
		Sentry.withScope((scope) => {
			scope.setTag('scheduled.lane', input.message.lane)
			scope.setContext('scheduled', {
				lane: input.message.lane,
				scheduledTime: scheduledAt.toISOString(),
				cron: input.message.cron,
			})
			Sentry.captureException(error)
		})
		return 'failed'
	}
}
