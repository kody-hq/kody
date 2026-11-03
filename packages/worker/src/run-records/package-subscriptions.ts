import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { readSignupOrgSlugOrNull } from '#worker/orgs/signup-org-slug.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	loadMatchingPackageSubscriptions,
	readPreExecutionPackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import type { EnablementAudience } from '#worker/enablements/run-gate.ts'
import type { RunLogRowInput } from './run-log-do.ts'

export const runErrorRecordedTopic = 'run.error.recorded'

type RunErrorRecordedSubscriptionEnvelope = {
	event: typeof runErrorRecordedTopic
	run: {
		id: string
		surface: string
		name: string | null
		package_id: string | null
		kody_id: string | null
		source_id: string | null
		published_commit: string | null
		storage_id: string | null
		job_id: string | null
		workflow_id: string | null
		invocation_id: string | null
		session_id: string | null
		parent_run_id: string | null
		started_at: string
		finished_at: string | null
		duration_ms: number | null
		error_name: string | null
		error_message: string | null
	}
	activity_url: string
}

function buildRunErrorEventPayload(input: {
	run: RunLogRowInput
	activityUrl: string
}): RunErrorRecordedSubscriptionEnvelope {
	return {
		event: runErrorRecordedTopic,
		run: {
			id: input.run.id,
			surface: input.run.surface,
			name: input.run.name,
			package_id: input.run.packageId,
			kody_id: input.run.kodyId,
			source_id: input.run.sourceId,
			published_commit: input.run.publishedCommit,
			storage_id: input.run.storageId,
			job_id: input.run.jobId,
			workflow_id: input.run.workflowId,
			invocation_id: input.run.invocationId,
			session_id: input.run.sessionId,
			parent_run_id: input.run.parentRunId,
			started_at: input.run.startedAt,
			finished_at: input.run.finishedAt,
			duration_ms: input.run.durationMs,
			error_name: input.run.errorName,
			error_message: input.run.errorMessage,
		},
		activity_url: input.activityUrl,
	}
}

function buildSubscriptionIdempotencyKey(input: {
	runId: string
	packageId: string
}) {
	return `run-error:${input.runId}:${input.packageId}:${runErrorRecordedTopic}`
}

function buildActivityUrl(input: {
	baseUrl: string
	orgSlug: string
	runId: string
}) {
	return `${input.baseUrl}${orgSectionRestPath(
		input.orgSlug,
		'activity',
		input.runId,
	)}`
}

async function loadMatchingRunErrorSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
}) {
	try {
		return await loadMatchingPackageSubscriptions({
			...input,
			topic: runErrorRecordedTopic,
		})
	} catch (error) {
		// Best-effort: discovery must not reject the dispatcher.
		return { subscriptions: [], discoveryErrors: [error] }
	}
}

/**
 * A run error reaches enablers who can see the run's package or job. An ad
 * hoc run has neither, so only Owners receive it.
 */
function runErrorAudience(run: RunLogRowInput): EnablementAudience {
	if (run.packageId) return { resource: { type: 'package', id: run.packageId } }
	if (run.jobId) return { resource: { type: 'job', id: run.jobId } }
	return { resource: null }
}

/**
 * Fan a persisted terminal error run record out to the owning user's packages
 * that declare `run.error.recorded`. Best-effort: discovery and invocation
 * infrastructure failures are logged, never thrown — the observed run path
 * must not fail because a notifier could not be reached. Sibling handler
 * terminal failures are isolated via `Promise.allSettled`.
 */
export async function dispatchRunErrorSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	run: RunLogRowInput
	orgSlug?: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (input.run.status !== 'error') return []
	if (input.run.surface === 'subscription') return []

	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingRunErrorSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
		})
	const orgSlug = await readSignupOrgSlugOrNull(
		input.env.APP_DB,
		input.userId,
		input.orgSlug,
	)
	if (!orgSlug) {
		if (discoveryErrors.length > 0) {
			console.warn(
				'run.error.recorded package subscription discovery incomplete',
				{
					runId: input.run.id,
					errorCount: discoveryErrors.length,
					error: discoveryErrors[0],
				},
			)
		}
		return []
	}
	const eventPayload = buildRunErrorEventPayload({
		run: input.run,
		activityUrl: buildActivityUrl({
			baseUrl,
			orgSlug,
			runId: input.run.id,
		}),
	})
	const settled = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: runErrorRecordedTopic,
						params: eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							runId: input.run.id,
							packageId: savedPackage.id,
						}),
						source: 'run-records',
						request: { kind: 'platform-event', sourceId: 'run-records' },
						audience: runErrorAudience(input.run),
						waitUntil: input.waitUntil,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)
	for (const result of settled) {
		if (result.status === 'rejected') {
			console.warn('run.error.recorded package subscription invoke failed', {
				runId: input.run.id,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		console.warn(
			'run.error.recorded package subscription discovery incomplete',
			{
				runId: input.run.id,
				errorCount: discoveryErrors.length,
				error: discoveryErrors[0],
			},
		)
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}
