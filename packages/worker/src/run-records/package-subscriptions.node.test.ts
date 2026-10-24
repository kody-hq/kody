import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as serviceModule from '#worker/package-invocations/service.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(
		async (
			_input: Parameters<typeof serviceModule.invokePackageSubscription>[0],
		) => ({ status: 200, body: {} }),
	),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

const { dispatchRunErrorSubscriptionEvents, runErrorRecordedTopic } =
	await import('./package-subscriptions.ts')

function errorRun(overrides: Record<string, unknown> = {}) {
	return {
		id: 'run-1',
		surface: 'job',
		status: 'error',
		name: 'daily-sync',
		packageId: 'pkg-owner',
		kodyId: 'daily-sync',
		sourceId: 'source-owner',
		publishedCommit: 'commit-1',
		storageId: 'storage-1',
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-27T12:00:00.000Z',
		finishedAt: '2026-07-27T12:00:01.000Z',
		durationMs: 1000,
		errorName: 'Error',
		errorMessage: 'boom',
		startedBy: null,
		metadataJson: '{}',
		createdAt: '2026-07-27T12:00:00.000Z',
		updatedAt: '2026-07-27T12:00:01.000Z',
		...overrides,
	}
}

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env
}

function subscribedManifest(input: {
	name: string
	kodyId: string
	handler?: string
}) {
	return {
		manifest: {
			name: input.name,
			kody: {
				id: input.kodyId,
				description: 'Error notifier',
				subscriptions: {
					[runErrorRecordedTopic]: {
						handler: input.handler ?? './src/on-run-error.ts',
					},
				},
			},
		},
	}
}

function savedPackage(index: number, kodyId: string) {
	return {
		id: `package-${index}`,
		userId: ownerIdFromStored('user-1'),
		sourceId: `source-${index}`,
		kodyId,
		name: `@user/${kodyId}`,
	}
}

test('run.error.recorded fans out only to owning-user packages with a lean payload', async () => {
	const notifier = savedPackage(1, 'error-notifier')
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([notifier])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce(
		subscribedManifest({
			name: '@user/error-notifier',
			kodyId: 'error-notifier',
		}),
	)
	const env = createEnv()
	const run = errorRun()

	const results = await dispatchRunErrorSubscriptionEvents({
		env,
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'ada',
		run: run as never,
	})

	expect(results).toHaveLength(1)
	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage: notifier,
			topic: runErrorRecordedTopic,
			idempotencyKey: `run-error:run-1:package-1:${runErrorRecordedTopic}`,
			source: 'run-records',
			params: expect.objectContaining({
				event: runErrorRecordedTopic,
				activity_url: 'https://example.com/@ada/-/activity/run-1',
				run: expect.objectContaining({
					id: 'run-1',
					surface: 'job',
					name: 'daily-sync',
					package_id: 'pkg-owner',
					kody_id: 'daily-sync',
					source_id: 'source-owner',
					published_commit: 'commit-1',
					storage_id: 'storage-1',
					job_id: 'job-1',
					workflow_id: null,
					invocation_id: null,
					session_id: null,
					parent_run_id: null,
					started_at: '2026-07-27T12:00:00.000Z',
					finished_at: '2026-07-27T12:00:01.000Z',
					duration_ms: 1000,
					error_name: 'Error',
					error_message: 'boom',
				}),
			}),
		}),
	)
	const params = mocks.invokePackageSubscription.mock.calls[0]?.[0]?.params as
		| Record<string, unknown>
		| undefined
	expect(params).not.toHaveProperty('metadata')
	expect(params?.['run']).not.toHaveProperty('metadata')
	expect(params?.['run']).not.toHaveProperty('logs')
})

test('run.error.recorded skips recursion/non-errors and never throws on handler failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const dispatch = (run: ReturnType<typeof errorRun>) =>
		dispatchRunErrorSubscriptionEvents({
			env: createEnv(),
			userId: ownerIdFromStored('user-1'),
			orgSlug: 'ada',
			run: run as never,
		})

	for (const run of [
		errorRun({ surface: 'subscription' }),
		errorRun({ status: 'success', errorName: null, errorMessage: null }),
	]) {
		await expect(dispatch(run)).resolves.toEqual([])
	}
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()

	mocks.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	await expect(dispatch(errorRun())).resolves.toEqual([])
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'run.error.recorded package subscription discovery incomplete',
		expect.objectContaining({
			runId: 'run-1',
			errorCount: 1,
		}),
	)
	const discoveryWarn = consoleWarn.mock.calls.find(
		(call) =>
			call[0] ===
			'run.error.recorded package subscription discovery incomplete',
	)?.[1] as Record<string, unknown> | undefined
	expect(discoveryWarn).not.toHaveProperty('userId')

	mocks.listSavedPackagesByUserId.mockResolvedValueOnce(
		(['error-notifier', 'broken', 'notifier-b'] as const).map((kodyId, i) =>
			savedPackage(i + 1, kodyId),
		),
	)
	mocks.loadPackageManifestBySourceId
		.mockResolvedValueOnce(
			subscribedManifest({
				name: '@user/error-notifier',
				kodyId: 'error-notifier',
			}),
		)
		.mockRejectedValueOnce(new Error('manifest unavailable'))
		.mockResolvedValueOnce(
			subscribedManifest({ name: '@user/notifier-b', kodyId: 'notifier-b' }),
		)
	mocks.invokePackageSubscription
		.mockRejectedValueOnce(new Error('handler boom'))
		.mockResolvedValueOnce({ status: 200, body: { ok: true } })

	await expect(dispatch(errorRun())).resolves.toEqual([
		null,
		{ status: 200, body: { ok: true } },
	])
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'run.error.recorded package subscription invoke failed',
		expect.objectContaining({ runId: 'run-1', error: expect.any(Error) }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({ packageId: 'package-2' }),
	)
})
