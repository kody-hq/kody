import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { env, runInDurableObject } from 'cloudflare:test'
import type * as SystemEmail from '#worker/email/system-email.ts'
import type * as SecondAgentGiftReconciliation from '#worker/entitlements/second-agent-gift-reconciliation.ts'
import type * as D1StorageReconciliation from '#worker/entitlements/d1-storage-reconciliation.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	oauthPurgeContinuationStorageKey,
	type OAuthPurgeCoordinator,
	type PurgeContinuation,
} from './oauth-purge.ts'

const mocks = vi.hoisted(() => ({
	reconcileArtifactsPushes: vi.fn(async () => ({})),
	sweepStaleInboundDeliveries: vi.fn(async () => ({})),
	cleanupRepoSessionBranches: vi.fn(async () => ({})),
	pruneSystemEmailRetention: vi.fn(async () => ({})),
	pruneRetention: vi.fn(async () => ({})),
	checkAuthDenialBurstAndNotify: vi.fn(async () => ({
		status: 'below_threshold',
		count: 0,
	})),
	checkWebhookAuthRegressionsAndAlert: vi.fn(async () => ({
		ownersScanned: 0,
		ownersFailed: 0,
		candidates: 0,
		regressions: [],
		alerted: 0,
		cooldown: 0,
	})),
	aggregateUsageRollups: vi.fn(async () => ({ skipped: true })),
	runCreditDebits: vi.fn(async () => ({
		scanned: 0,
		debitedUsers: 0,
		debitedMicroUsd: 0,
		autoRefilled: 0,
		failed: 0,
		done: true,
	})),
	refreshAdminInsightsRunLogSnapshot: vi.fn(async () => ({
		complete: true,
		snapshotUpdatedAt: '2026-09-10T00:00:00.000Z',
		usersWithRunLog: 0,
		usersMissingRunLog: 0,
		runs: 0,
		medianRunDurationMs: null,
		hours: [],
	})),
	backfillStorageBucketEstimates: vi.fn(async () => ({
		scanned: 0,
		updated: 0,
		failed: 0,
	})),
	reconcileSecondAgentStandardGifts: vi.fn(
		async (
			_input: Parameters<
				typeof SecondAgentGiftReconciliation.reconcileSecondAgentStandardGifts
			>[0],
		) => ({ scanned: 0, granted: 0, failed: 0 }),
	),
	reconcileD1StorageBytes: vi.fn(
		async (
			_input: Parameters<
				typeof D1StorageReconciliation.reconcileD1StorageBytes
			>[0],
		) => ({
			scanned: 0,
			updated: 0,
			failed: 0,
		}),
	),
}))

vi.mock('./jobs/reconcile-artifacts-pushes.ts', () => ({
	reconcileArtifactsPushes: mocks.reconcileArtifactsPushes,
}))

vi.mock('./repo/repo-session-cleanup.ts', () => ({
	cleanupRepoSessionBranches: mocks.cleanupRepoSessionBranches,
}))

vi.mock('#worker/email/system-email.ts', async (importOriginal) => ({
	...(await importOriginal<typeof SystemEmail>()),
	pruneSystemEmailRetention: mocks.pruneSystemEmailRetention,
}))

vi.mock('#worker/email/reconcile-inbound-deliveries.ts', () => ({
	sweepStaleInboundDeliveries: mocks.sweepStaleInboundDeliveries,
}))

vi.mock('#app/retention.ts', () => ({
	pruneRetention: mocks.pruneRetention,
}))

vi.mock('#app/auth-denial-alerts.ts', () => ({
	checkAuthDenialBurstAndNotify: mocks.checkAuthDenialBurstAndNotify,
}))

vi.mock('#worker/webhooks/auth-regression-alert.ts', () => ({
	checkWebhookAuthRegressionsAndAlert:
		mocks.checkWebhookAuthRegressionsAndAlert,
}))

vi.mock('#worker/usage/aggregate-rollups.ts', () => ({
	aggregateUsageRollups: mocks.aggregateUsageRollups,
}))

vi.mock('#worker/billing/credit-debits.ts', () => ({
	runCreditDebits: mocks.runCreditDebits,
}))

vi.mock('#worker/admin/insights-runlog-snapshot.ts', () => ({
	refreshAdminInsightsRunLogSnapshot: mocks.refreshAdminInsightsRunLogSnapshot,
}))

vi.mock('#worker/storage-buckets/estimate-backfill.ts', () => ({
	backfillStorageBucketEstimates: mocks.backfillStorageBucketEstimates,
}))

vi.mock('#worker/entitlements/second-agent-gift-reconciliation.ts', () => ({
	reconcileSecondAgentStandardGifts: mocks.reconcileSecondAgentStandardGifts,
}))

vi.mock('#worker/entitlements/d1-storage-reconciliation.ts', () => ({
	d1StorageReconciliationBatchSize: 8,
	reconcileD1StorageBytes: mocks.reconcileD1StorageBytes,
}))

const { runScheduledLane, runScheduledLaneWithFailureIsolation } =
	await import('./scheduled/scheduled-lanes.ts')

const cron = '*/5 * * * *'

function createMessage(lane: string, scheduledTime: number) {
	return {
		lane,
		scheduledTime,
		cron,
	} as Parameters<typeof runScheduledLaneWithFailureIsolation>[0]['message']
}

async function resetOAuthPurgeCoordinator(seed?: PurgeContinuation) {
	const coordinator = env.OAUTH_PURGE_COORDINATOR.get(
		env.OAUTH_PURGE_COORDINATOR.idFromName('global'),
	)
	await runInDurableObject(
		coordinator,
		async (_instance: OAuthPurgeCoordinator, state) => {
			await state.storage.deleteAll()
			if (seed) await state.storage.put(oauthPurgeContinuationStorageKey, seed)
		},
	)
	return coordinator
}

function readPurgeContinuation(
	coordinator: Awaited<ReturnType<typeof resetOAuthPurgeCoordinator>>,
) {
	return runInDurableObject(
		coordinator,
		(_instance: OAuthPurgeCoordinator, state) =>
			state.storage.get<PurgeContinuation>(oauthPurgeContinuationStorageKey),
	)
}

async function kvHas(key: string | undefined) {
	return (await env.OAUTH_KV.get(key ?? '')) !== null
}

const padded = (index: number) => index.toString().padStart(3, '0')

test('platform lanes execute with their expected inputs and jobs-owned lanes are rejected', async () => {
	const scheduledTime = Date.parse('2026-07-05T10:05:30.000Z')
	const scheduledAt = new Date(scheduledTime)
	for (const lane of [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
		'reconcile_inbound_deliveries',
		'system_email_retention',
		'storage_bucket_estimate_backfill',
		'd1_storage_reconciliation',
		'second_agent_gift_reconciliation',
		'retention',
		'usage_aggregation',
		'auth_denial_alert',
	] as const) {
		await runScheduledLane({ env, lane, scheduledAt })
	}
	// community_listing_behind_backfill: mocking it here breaks OAuth Durable
	// Object RPC in this file; the live path soft-fails when community_listings
	// is absent (workers harness). Behavior is covered in node tests.
	consoleWarn.mockImplementation(() => {})
	await expect(
		runScheduledLane({
			env,
			lane: 'community_listing_behind_backfill',
			scheduledAt,
		}),
	).resolves.toEqual({ scanned: 0, synced: 0, failed: 0 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'community-listing-behind-backfill-scan-failed',
		expect.anything(),
	)
	consoleWarn.mockReset()

	for (const laneMock of [
		mocks.reconcileArtifactsPushes,
		mocks.sweepStaleInboundDeliveries,
		mocks.refreshAdminInsightsRunLogSnapshot,
		mocks.checkAuthDenialBurstAndNotify,
		mocks.checkWebhookAuthRegressionsAndAlert,
		mocks.backfillStorageBucketEstimates,
		mocks.pruneRetention,
	]) {
		expect(laneMock).toHaveBeenCalledWith(
			expect.objectContaining({ now: scheduledAt }),
		)
	}
	expect(mocks.cleanupRepoSessionBranches).toHaveBeenCalledTimes(1)
	expect(mocks.pruneSystemEmailRetention).toHaveBeenCalledWith(
		expect.objectContaining({ blobs: env.EMAIL_BLOBS }),
	)
	expect(mocks.aggregateUsageRollups).toHaveBeenCalledWith(env, scheduledAt)
	expect(mocks.runCreditDebits).toHaveBeenCalledWith({
		env,
		now: scheduledAt,
	})
	expect(
		mocks.reconcileSecondAgentStandardGifts,
	).toHaveBeenCalledExactlyOnceWith({ env, now: scheduledAt })
	expect(mocks.reconcileD1StorageBytes).toHaveBeenCalledTimes(1)
	const reconciliationInput = mocks.reconcileD1StorageBytes.mock.calls[0]?.[0]
	expect(reconciliationInput?.db).toBe(env.APP_DB)
	expect(reconciliationInput?.env).toEqual(
		expect.objectContaining({ APP_DB: env.APP_DB }),
	)
	expect(reconciliationInput?.now).toEqual(scheduledAt)

	await expect(
		runScheduledLane({
			env,
			lane: 'job_schedule_watchdog',
			scheduledAt: new Date(),
		}),
	).rejects.toThrow(/owned by the jobs worker/)
})

test('scheduled OAuth purge advances and revokes every grant token before the grant', async () => {
	const scheduledTime = Date.parse('2026-07-05T10:05:00.000Z')
	const userId = ownerIdFromStored('oauth-purge-user')
	const clientId = 'oauth-purge-client'
	const healthyGrantIds = Array.from(
		{ length: 51 },
		(_, index) => `${padded(index)}-healthy`,
	)
	const orphanGrantId = 'zzz-orphan'
	const orphanGrantKey = `grant:${userId}:${orphanGrantId}`
	const orphanTokenKeys = Array.from(
		{ length: 51 },
		(_, index) => `token:${userId}:${orphanGrantId}:${padded(index)}`,
	)
	const lastHealthyGrantId = healthyGrantIds.at(-1)

	await resetOAuthPurgeCoordinator()
	await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify({ clientId }))
	await Promise.all([
		...healthyGrantIds.flatMap((grantId) => [
			env.OAUTH_KV.put(
				`grant:${userId}:${grantId}`,
				JSON.stringify({ id: grantId, userId, clientId }),
			),
			env.OAUTH_KV.put(
				`token:${userId}:${grantId}:healthy-token`,
				JSON.stringify({ userId, grantId }),
			),
		]),
		env.OAUTH_KV.put(
			orphanGrantKey,
			JSON.stringify({ id: orphanGrantId, userId, clientId: 'missing-client' }),
		),
		...orphanTokenKeys.map((key) =>
			env.OAUTH_KV.put(key, JSON.stringify({ userId, grantId: orphanGrantId })),
		),
	])

	const runPurgeTick = (minutes: number) =>
		runScheduledLane({
			env,
			lane: 'oauth_purge_expired',
			scheduledAt: new Date(scheduledTime + minutes * 60_000),
		})

	await runPurgeTick(0)
	expect(await kvHas(orphanGrantKey)).toBe(true)
	expect(await kvHas(orphanTokenKeys[0])).toBe(true)

	await runPurgeTick(5)
	expect(await kvHas(orphanGrantKey)).toBe(true)

	await runPurgeTick(10)
	expect(await kvHas(orphanGrantKey)).toBe(true)
	expect(await kvHas(orphanTokenKeys[0])).toBe(false)
	expect(await kvHas(orphanTokenKeys.at(-1))).toBe(true)

	await runPurgeTick(15)
	expect(await kvHas(orphanGrantKey)).toBe(true)

	await runPurgeTick(20)
	expect(await kvHas(orphanGrantKey)).toBe(false)
	await expect(
		Promise.all(orphanTokenKeys.map((key) => env.OAUTH_KV.get(key))),
	).resolves.toEqual(orphanTokenKeys.map(() => null))
	expect(await kvHas(`grant:${userId}:${lastHealthyGrantId}`)).toBe(true)
	expect(
		await kvHas(`token:${userId}:${lastHealthyGrantId}:healthy-token`),
	).toBe(true)
})

test('OAuth purge resets only invalid persisted cursors and serializes overlapping invocations', async () => {
	const invalidCursor = '%%%'
	const recovering = await resetOAuthPurgeCoordinator({
		version: 1,
		nextPhase: 'grants',
		grantCursor: invalidCursor,
	})
	await env.OAUTH_KV.put(
		'client:cursor-recovery-client',
		JSON.stringify({ clientId: 'cursor-recovery-client' }),
	)
	await env.OAUTH_KV.put(
		'grant:cursor-recovery-user:grant',
		JSON.stringify({ clientId: 'cursor-recovery-client' }),
	)

	const result = await recovering.run({
		scheduledAt: Date.parse('2026-07-05T11:00:00.000Z'),
	})
	expect(result.phase).toBe('grants')
	expect(result.checked).toBeGreaterThan(0)
	const recovered = await readPurgeContinuation(recovering)
	expect(recovered?.grantCursor).not.toBe(invalidCursor)
	expect(recovered?.nextPhase).toBe('tokens')

	const overlapping = await resetOAuthPurgeCoordinator()
	await env.OAUTH_KV.put(
		'client:overlap-client',
		JSON.stringify({ clientId: 'overlap-client' }),
	)
	await Promise.all(
		Array.from({ length: 51 }, (_, index) =>
			env.OAUTH_KV.put(
				`grant:overlap-user:${padded(index)}`,
				JSON.stringify({ clientId: 'overlap-client' }),
			),
		),
	)
	const scheduledAt = Date.parse('2026-07-05T11:05:00.000Z')
	const [first, second] = await Promise.all([
		overlapping.run({ scheduledAt }),
		overlapping.run({ scheduledAt }),
	])
	expect([first.phase, second.phase]).toEqual(['grants', 'tokens'])
	const continuation = await readPurgeContinuation(overlapping)
	expect(continuation?.nextPhase).toBe('grants')
	expect(continuation?.grantCursor).toBeTruthy()
})

test('lane failure isolation reports ordinary errors to Sentry and treats D1 lock contention as retryable', async () => {
	const consoleErrorSpy = vi
		.spyOn(console, 'error')
		.mockImplementation(() => {})
	const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const withScope = vi.spyOn(Sentry, 'withScope')
	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')
	mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
		new Error('reconcile exploded'),
	)
	const failedTime = Date.parse('2026-07-05T10:10:00.000Z')

	try {
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: createMessage('reconcile_artifacts_pushes', failedTime),
			}),
		).resolves.toBe('failed')

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'scheduled_lane_failed lane=reconcile_artifacts_pushes',
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
		expect(withScope).toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
		const scopeCallback = withScope.mock.calls[0]?.[0] as
			| ((scope: {
					setTag: (key: string, value: string) => void
					setContext: (key: string, value: Record<string, unknown>) => void
			  }) => void)
			| undefined
		expect(scopeCallback).toBeTypeOf('function')
		const setTag = vi.fn()
		const setContext = vi.fn()
		scopeCallback?.({ setTag, setContext })
		expect(setTag).toHaveBeenCalledWith(
			'scheduled.lane',
			'reconcile_artifacts_pushes',
		)
		expect(setContext).toHaveBeenCalledWith(
			'scheduled',
			expect.objectContaining({
				lane: 'reconcile_artifacts_pushes',
				scheduledTime: new Date(failedTime).toISOString(),
				cron,
			}),
		)

		captureException.mockClear()
		mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		const lockTime = Date.parse('2026-07-05T10:20:00.000Z')
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: createMessage('reconcile_artifacts_pushes', lockTime),
			}),
		).resolves.toBe('d1_lock_contention')

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'scheduled_lane_d1_lock_contention lane=reconcile_artifacts_pushes',
			expect.objectContaining({
				message: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
			}),
		)
		expect(captureException).not.toHaveBeenCalled()
	} finally {
		consoleErrorSpy.mockRestore()
		consoleWarnSpy.mockRestore()
		withScope.mockRestore()
		captureException.mockRestore()
	}
})
