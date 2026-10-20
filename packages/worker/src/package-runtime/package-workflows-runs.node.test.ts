import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { sessionRequestLineage } from '#worker/test-support/request-context.ts'
import type * as PackageInvocationsService from '#worker/package-invocations/service.ts'
import type * as RunKodyRegistry from '#mcp/run-kody-registry.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import { type WorkflowProjectionUpsertInput } from '#worker/run-records/service.ts'
import {
	DynamicCallableWorkflowBase,
	cancelWorkflowRunForUser,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	listWorkflowRunsForUser,
	type DynamicCallableWorkflowPayload,
} from './package-workflows.ts'
import {
	packageWorkflowsInvocationMocks as invocationMocks,
	packageWorkflowsRunRecordMocks as runRecordMocks,
	seedActiveWorkflowProjections,
	createWorkflowBinding,
	createStatefulWorkflowBinding,
	createWorkflowRunsDatabase,
} from '#worker/test-support/package-workflows.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (
		...args: Parameters<typeof PackageInvocationsService.invokePackageExport>
	) => invocationMocks.invokePackageExport(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (
		...args: Parameters<typeof RunKodyRegistry.runModuleWithRegistry>
	) => invocationMocks.runModuleWithRegistry(...args),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: `${userId}@example.com`,
		username: userId,
		displayName: userId,
	}),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	beginRunRecord: (
		...args: Parameters<typeof RunRecordsServiceModule.beginRunRecord>
	) => runRecordMocks.beginRunRecord(...args),
	finishRunRecord: (
		...args: Parameters<typeof RunRecordsServiceModule.finishRunRecord>
	) => runRecordMocks.finishRunRecord(...args),
	upsertWorkflowProjection: (...args: Array<unknown>) =>
		runRecordMocks.upsertWorkflowProjection(
			...(args as [
				{
					env: Env
					userId: string
					projection: WorkflowProjectionUpsertInput
				},
			]),
		),
	releaseWorkflowProjectionIdempotencyKey: (...args: Array<unknown>) =>
		runRecordMocks.releaseWorkflowProjectionIdempotencyKey(
			...(args as [{ env: Env; userId: string; id: string }]),
		),
	getWorkflowProjection: (...args: Array<unknown>) =>
		runRecordMocks.getWorkflowProjection(
			...(args as [{ env: Env; userId: string; id: string }]),
		),
	findWorkflowProjectionByIdempotencyKey: (...args: Array<unknown>) =>
		runRecordMocks.findWorkflowProjectionByIdempotencyKey(
			...(args as [
				{
					env: Env
					userId: string
					idempotencyKey: string
					bindingName?: string | null
				},
			]),
		),
	listWorkflowProjections: (...args: Array<unknown>) =>
		runRecordMocks.listWorkflowProjections(
			...(args as [
				{
					env: Env
					userId: string
					limit?: number | null
					cursor?: string | null
					status?: string | null
					bindingName?: string | null
				},
			]),
		),
	countActiveWorkflowProjections: (...args: Array<unknown>) =>
		runRecordMocks.countActiveWorkflowProjections(
			...(args as [{ env: Env; userId: string }]),
		),
	reserveWorkflowProjectionSlot: (...args: Array<unknown>) =>
		runRecordMocks.reserveWorkflowProjectionSlot(
			...(args as [
				{
					env: Env
					userId: string
					projection: WorkflowProjectionUpsertInput
				},
			]),
		),
	deleteWorkflowProjectionIfCreating: (...args: Array<unknown>) =>
		runRecordMocks.deleteWorkflowProjectionIfCreating(
			...(args as [{ env: Env; userId: string; id: string }]),
		),
}))

const inlineCode =
	'export default async function main() { return { ok: true } }'
const packageBody = {
	packageId: 'pkg-1',
	exportName: './workflow-run-event',
}

function createWorkflowEnv(
	binding: { workflow: Workflow } = createStatefulWorkflowBinding(),
	db = createWorkflowRunsDatabase(),
) {
	return {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		APP_BASE_URL: 'https://app.example.com',
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
}

function createInline(
	env: Env,
	body: Record<string, unknown>,
	userId = 'user-1',
) {
	return createDynamicCallableWorkflow({
		env,
		userId: ownerIdFromStored(userId),
		lineage: sessionRequestLineage(userId),
		body: { code: inlineCode, ...body } as never,
	})
}

const findRun = (id: string) =>
	runRecordMocks.listForUser('user-1').find((row) => row.id === id)

function createInlineStep() {
	return {
		sleepUntil: vi.fn(),
		do: vi.fn(
			async (_name: string, _config: unknown, callback: () => unknown) =>
				await callback(),
		),
	} as unknown as WorkflowStep
}

function queuedPayload(
	binding: ReturnType<typeof createStatefulWorkflowBinding>,
	id: string,
): WorkflowEvent<DynamicCallableWorkflowPayload> {
	const queued = binding.instances.get(id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	return {
		payload: queued.params as DynamicCallableWorkflowPayload,
		timestamp: new Date(),
		instanceId: id,
		workflowName: 'dynamic-callable-workflow',
	}
}

async function withClock<T>(iso: string, run: () => Promise<T>) {
	vi.setSystemTime(new Date(iso))
	return await run()
}

test('createDynamicCallableWorkflow verifies package ownership before queueing package exports', async () => {
	runRecordMocks.resetProjections()
	const binding = createWorkflowBinding({ existing: null })
	const env = createWorkflowEnv(binding)
	const runAt = '2026-05-03T12:34:56.000Z'

	const created = await createDynamicCallableWorkflow({
		env,
		userId: ownerIdFromStored('user-1'),
		lineage: sessionRequestLineage('user-1'),
		packageContext: null,
		body: {
			...packageBody,
			exportName: './run-event',
			runAt,
			idempotencyKey: 'event-key',
			params: { eventId: 'event-1' },
		},
	})
	expect(created).toMatchObject({
		source_type: 'package',
		package_id: 'pkg-1',
		workflow_name: './run-event',
		export_name: './run-event',
	})
	expect(binding.create).toHaveBeenCalledWith({
		id: created.id,
		params: expect.objectContaining({
			sourceType: 'package',
			packageId: 'pkg-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
		}),
		retention: expect.any(Object),
	})

	await expect(
		createDynamicCallableWorkflow({
			env: createWorkflowEnv(
				binding,
				createWorkflowRunsDatabase({ savedPackage: null }),
			),
			userId: ownerIdFromStored('user-1'),
			lineage: sessionRequestLineage('user-1'),
			body: {
				packageId: 'not-owned',
				exportName: './run-event',
				runAt,
				// Distinct key: same-key replay is satisfied from the user-scoped
				// RunLog projection before package ownership is resolved.
				idempotencyKey: 'not-owned-key',
			},
		}),
	).rejects.toThrow(
		'Package "not-owned" was not found or is not owned by the current user.',
	)
	await expect(
		createInline(env, {
			exportName: './run-event',
			runAt,
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires exactly one of exportName or code.',
	)
})

test('createDynamicCallableWorkflow dedupes queued runs by user and idempotency key', async () => {
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const env = createWorkflowEnv(binding)
	const packageRun = (runAt: string, idempotencyKey = 'idempotency-repro') =>
		createDynamicCallableWorkflow({
			env,
			userId: ownerIdFromStored('user-1'),
			lineage: sessionRequestLineage('user-1'),
			body: {
				...packageBody,
				runAt,
				idempotencyKey,
				params: { date: '2026-05-08', key: 'noop' },
			},
		})

	const first = await packageRun('2026-05-08T19:30:00.000Z')
	const replay = await packageRun('2026-05-08T19:31:00.000Z')
	expect(replay).toMatchObject({
		ok: true,
		id: first.id,
		source_type: 'package',
		package_id: 'pkg-1',
		export_name: './workflow-run-event',
		run_at: first.run_at,
	})
	expect(binding.create).toHaveBeenCalledTimes(1)
	expect(binding.instances.size).toBe(1)
	expect(runRecordMocks.listForUser('user-1')).toEqual([
		expect.objectContaining({
			idempotencyKey: 'idempotency-repro',
			runAt: '2026-05-08T19:30:00.000Z',
			bindingName: dynamicCallableWorkflowsBindingName,
		}),
	])

	// Terminal (errored) projections still satisfy same-key replay until the
	// key is released (durable escalation releases after a dead terminal).
	runRecordMocks.resetProjections()
	const erroredFirst = await packageRun(
		'2026-05-08T19:30:00.000Z',
		'terminal-key',
	)
	const erroredStored = findRun(erroredFirst.id)
	if (!erroredStored) throw new Error('Expected stored workflow projection.')
	erroredStored.status = 'errored'
	const erroredReplay = await packageRun(
		'2026-05-08T19:31:00.000Z',
		'terminal-key',
	)
	expect(erroredReplay.id).toBe(erroredFirst.id)
	expect(erroredReplay.status).toBe('errored')
	expect(binding.create).toHaveBeenCalledTimes(2)

	await runRecordMocks.releaseWorkflowProjectionIdempotencyKey({
		env,
		userId: ownerIdFromStored('user-1'),
		id: erroredFirst.id,
	})
	const afterRelease = await packageRun(
		'2026-05-08T19:32:00.000Z',
		'terminal-key',
	)
	expect(afterRelease.id).not.toBe(erroredFirst.id)
	expect(afterRelease.status).toBe('queued')
	expect(binding.create).toHaveBeenCalledTimes(3)
	expect(findRun(erroredFirst.id)?.idempotencyKey).toBe(
		`released:${erroredFirst.id}`,
	)
	expect(findRun(afterRelease.id)?.idempotencyKey).toBe('terminal-key')

	// A second terminal failure must walk the successor chain (not reuse B).
	const secondStored = findRun(afterRelease.id)
	if (!secondStored) throw new Error('Expected second workflow projection.')
	secondStored.status = 'errored'
	await runRecordMocks.releaseWorkflowProjectionIdempotencyKey({
		env,
		userId: ownerIdFromStored('user-1'),
		id: afterRelease.id,
	})
	const afterSecondRelease = await packageRun(
		'2026-05-08T19:33:00.000Z',
		'terminal-key',
	)
	expect(afterSecondRelease.id).not.toBe(erroredFirst.id)
	expect(afterSecondRelease.id).not.toBe(afterRelease.id)
	expect(afterSecondRelease.status).toBe('queued')
	expect(binding.create).toHaveBeenCalledTimes(4)
	expect(findRun(afterSecondRelease.id)?.idempotencyKey).toBe('terminal-key')

	// The key is scoped per user.
	runRecordMocks.resetProjections()
	const perUserBinding = createStatefulWorkflowBinding()
	const [userOne, userTwo] = await Promise.all(
		['user-1', 'user-2'].map((userId) =>
			createDynamicCallableWorkflow({
				env: createWorkflowEnv(
					perUserBinding,
					createWorkflowRunsDatabase({
						savedPackage: {
							id: 'pkg-1',
							user_id: userId,
							name: 'Shade automation',
							kody_id: 'shade-automation',
							description: 'Shade automation package',
							tags_json: '[]',
							search_text: null,
							source_id: 'source-1',
							has_app: 0,
							created_at: '2026-05-03T00:00:00.000Z',
							updated_at: '2026-05-03T00:00:00.000Z',
						},
					}),
				),
				userId: ownerIdFromStored(userId),
				lineage: sessionRequestLineage(userId),
				body: {
					...packageBody,
					runAt: '2026-05-08T19:30:00.000Z',
					idempotencyKey: 'shared-key',
				},
			}),
		),
	)
	expect(userOne!.id).not.toBe(userTwo!.id)
	expect(perUserBinding.create).toHaveBeenCalledTimes(2)

	// An existing engine instance short-circuits before entitlement checks.
	runRecordMocks.resetProjections()
	const existingOverLimitBinding = createWorkflowBinding({})
	await seedActiveWorkflowProjections({
		userId: ownerIdFromStored('user-1'),
		count: 100,
	})
	await expect(
		createInline(createWorkflowEnv(existingOverLimitBinding), {
			idempotencyKey: 'existing-over-limit-key',
		}),
	).resolves.toMatchObject({ ok: true, status: 'waiting' })
	expect(existingOverLimitBinding.create).not.toHaveBeenCalled()

	vi.useFakeTimers()
	try {
		// Replays during the creating reservation reuse the reserved run.
		runRecordMocks.resetProjections()
		const preProjectionBinding = createStatefulWorkflowBinding()
		const statefulCreate = preProjectionBinding.create.getMockImplementation()!
		preProjectionBinding.create.mockImplementationOnce(async (input) => {
			expect(runRecordMocks.listForUser('user-1')).toEqual([
				expect.objectContaining({
					id: input.id,
					idempotencyKey: 'inline-pre-projection-key',
					runAt: '2026-05-08T19:30:00.000Z',
					status: creatingWorkflowProjectionStatus,
					bindingName: dynamicCallableWorkflowsBindingName,
				}),
			])
			return await statefulCreate(input)
		})
		const preProjectionEnv = createWorkflowEnv(preProjectionBinding)
		const inlineRun = () =>
			createInline(preProjectionEnv, {
				idempotencyKey: 'inline-pre-projection-key',
			})
		const firstPreProjection = await withClock(
			'2026-05-08T19:30:00.000Z',
			inlineRun,
		)
		const replayPreProjection = await withClock(
			'2026-05-08T19:31:00.000Z',
			inlineRun,
		)
		expect(replayPreProjection.id).toBe(firstPreProjection.id)
		expect(replayPreProjection.run_at).toBe(firstPreProjection.run_at)
		expect(preProjectionBinding.create).toHaveBeenCalledTimes(1)
		expect(preProjectionBinding.instances.size).toBe(1)

		// Non-duplicate engine failures release the creating reservation, so a
		// retry creates a fresh run.
		runRecordMocks.resetProjections()
		const retryBinding = createStatefulWorkflowBinding()
		retryBinding.create.mockRejectedValueOnce(
			new Error('transient workflow create failure'),
		)
		const retryEnv = createWorkflowEnv(retryBinding)
		const retryRun = () =>
			createInline(retryEnv, { idempotencyKey: 'failed-create-retry-key' })
		await expect(
			withClock('2026-05-08T19:30:00.000Z', retryRun),
		).rejects.toThrow('transient workflow create failure')
		expect(runRecordMocks.listForUser('user-1')).toEqual([])
		expect(runRecordMocks.deleteWorkflowProjectionIfCreating).toHaveBeenCalled()
		const retryAfterFailure = await withClock(
			'2026-05-08T19:31:00.000Z',
			retryRun,
		)
		expect(retryAfterFailure.run_at).toBe('2026-05-08T19:31:00.000Z')
		expect(retryBinding.create).toHaveBeenCalledTimes(2)
		expect(runRecordMocks.listForUser('user-1')).toEqual([
			expect.objectContaining({
				idempotencyKey: 'failed-create-retry-key',
				runAt: '2026-05-08T19:31:00.000Z',
				status: 'queued',
			}),
		])
	} finally {
		vi.useRealTimers()
	}
})

test('RunLog-only list, cancel, idempotency, and concurrency stay D1-free', async () => {
	runRecordMocks.resetProjections()
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const binding = createStatefulWorkflowBinding()
	const env = createWorkflowEnv(binding)
	const now = '2026-05-08T18:00:00.000Z'
	const seed = (id: string, idempotencyKey: string, status: string) =>
		runRecordMocks.upsertWorkflowProjection({
			env,
			userId: ownerIdFromStored('user-1'),
			projection: {
				id,
				bindingName: dynamicCallableWorkflowsBindingName,
				sourceType: 'inline',
				workflowName: 'inline-code',
				idempotencyKey,
				runAt: now,
				planDate: '2026-05-08',
				status,
				createdAt: now,
				updatedAt: now,
				...(status === 'complete' ? { completedAt: now } : {}),
			},
		})
	const activeIds = Array.from(
		{ length: freeLimit },
		(_, index) => `dynwf-active-${index}`,
	)
	for (const [index, id] of activeIds.entries()) {
		await seed(id, `active-${index}`, 'running')
		binding.instances.set(id, { id } as WorkflowInstanceCreateOptions)
	}
	await seed('dynwf-done', 'done-key', 'complete')
	await seed('dynwf-idem', 'idem-key', 'complete')

	const listed = await listWorkflowRunsForUser({
		env,
		userId: ownerIdFromStored('user-1'),
		limit: 25,
	})
	expect(listed.map((row) => row.id).sort()).toEqual(
		[...activeIds, 'dynwf-done', 'dynwf-idem'].sort(),
	)

	const runAt = '2026-05-08T19:30:00.000Z'
	const replay = await createInline(env, { idempotencyKey: 'idem-key', runAt })
	expect(replay.id).toBe('dynwf-idem')
	expect(replay.status).toBe('complete')
	expect(binding.create).not.toHaveBeenCalled()

	await expect(
		createInline(env, { idempotencyKey: 'blocked-by-active', runAt }),
	).rejects.toSatisfy((error: unknown) => isEntitlementLimitError(error))
	expect(binding.create).not.toHaveBeenCalled()

	const cancelled = await cancelWorkflowRunForUser({
		env,
		userId: ownerIdFromStored('user-1'),
		workflowRunId: activeIds[0]!,
	})
	expect(cancelled).toMatchObject({
		outcome: 'cancelled',
		run: { id: activeIds[0], status: 'cancelled' },
	})
	expect(findRun(activeIds[0]!)).toMatchObject({ status: 'cancelled' })
})

test('RunLog terminal stickiness blocks later active regression after cancel', async () => {
	runRecordMocks.resetProjections()
	const env = createWorkflowEnv()
	vi.useFakeTimers()
	try {
		const created = await withClock('2026-05-08T19:30:00.000Z', () =>
			createInline(env, {
				idempotencyKey: 'terminal-sticky-key',
				runAt: '2026-05-08T19:30:00.000Z',
			}),
		)
		await withClock('2026-05-08T19:31:00.000Z', () =>
			cancelWorkflowRunForUser({
				env,
				userId: ownerIdFromStored('user-1'),
				workflowRunId: created.id,
			}),
		)
		const cancelled = findRun(created.id)
		const cancelledShape = {
			status: 'cancelled',
			updatedAt: '2026-05-08T19:31:00.000Z',
		}
		expect(cancelled).toMatchObject(cancelledShape)
		if (!cancelled) throw new Error('Expected cancelled projection.')

		// A later queued write must not regress the terminal projection.
		await runRecordMocks.upsertWorkflowProjection({
			env,
			userId: ownerIdFromStored('user-1'),
			projection: {
				...cancelled,
				status: 'queued',
				completedAt: null,
				updatedAt: '2026-05-08T19:32:00.000Z',
			},
		})
		expect(findRun(created.id)).toMatchObject(cancelledShape)
	} finally {
		vi.useRealTimers()
	}
})

test('createDynamicCallableWorkflow enforces concurrent workflow entitlements across free, pro, and max plans', async () => {
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const proLimit = planLimits.pro.maxConcurrentWorkflows
	if (proLimit == null) throw new Error('Expected pro plan workflow limit.')
	const runAt = '2026-05-03T12:34:56.000Z'
	const countWhere = (predicate: (status: string | null) => boolean) =>
		runRecordMocks.listForUser('user-1').filter((row) => predicate(row.status))
			.length

	// Two racing creates for the last free slot: exactly one wins.
	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({
		userId: ownerIdFromStored('user-1'),
		count: freeLimit - 1,
	})
	const concurrentBinding = createStatefulWorkflowBinding()
	const concurrentEnv = createWorkflowEnv(concurrentBinding)
	const results = await Promise.allSettled(
		['concurrent-slot-a', 'concurrent-slot-b'].map((idempotencyKey) =>
			createInline(concurrentEnv, {
				idempotencyKey,
				runAt: '2026-05-08T19:30:00.000Z',
			}),
		),
	)
	const rejected = results.filter((result) => result.status === 'rejected')
	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1)
	expect(rejected).toHaveLength(1)
	expect(isEntitlementLimitError(rejected[0]?.reason)).toBe(true)
	expect(concurrentBinding.create).toHaveBeenCalledTimes(1)
	expect(
		countWhere(
			(status) =>
				status != null &&
				(activeWorkflowStatusValues as ReadonlyArray<string>).includes(status),
		),
	).toBe(freeLimit)
	expect(
		countWhere((status) => status === creatingWorkflowProjectionStatus),
	).toBe(0)

	async function expectDenied(
		promise: Promise<unknown>,
		input: { plan: string; limit: number; userId: string },
	) {
		const error = await promise.catch((caught: unknown) => caught)
		if (!isEntitlementLimitError(error)) {
			throw new Error(
				'Expected an EntitlementLimitError from createDynamicCallableWorkflow.',
			)
		}
		expect(error.message).toContain(
			`your "${input.plan}" plan allows at most ${input.limit} concurrent workflows`,
		)
		expect(error.details).toMatchObject({
			code: 'entitlement_limit_exceeded',
			resource: 'concurrent_workflows',
			plan: input.plan,
			limit: input.limit,
			current: input.limit,
		})
		expect(runRecordMocks.reserveWorkflowProjectionSlot).toHaveBeenCalledWith(
			expect.objectContaining({ userId: input.userId }),
		)
		expect(runRecordMocks.deleteWorkflowProjectionIfCreating).toHaveBeenCalled()
	}

	// A full free plan is denied from RunLog capacity alone and leaves no
	// reservation behind.
	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({
		userId: ownerIdFromStored('user-1'),
		count: freeLimit,
	})
	runRecordMocks.upsertWorkflowProjection.mockClear()
	runRecordMocks.reserveWorkflowProjectionSlot.mockClear()
	runRecordMocks.deleteWorkflowProjectionIfCreating.mockClear()
	const fullFreeBinding = createStatefulWorkflowBinding()
	await expectDenied(
		createInline(createWorkflowEnv(fullFreeBinding), {
			runAt,
			idempotencyKey: 'inline-key',
		}),
		{ plan: 'free', limit: freeLimit, userId: ownerIdFromStored('user-1') },
	)
	expect(fullFreeBinding.create).not.toHaveBeenCalled()
	expect(countWhere((status) => status === 'queued')).toBe(freeLimit)
	expect(activeWorkflowStatusValues).toContain('queued')

	const email = 'plan-user@example.com'
	const userId = testStableUserIdFromEmail(email)
	const planEnv = (plan: string) =>
		createWorkflowEnv(
			createStatefulWorkflowBinding(),
			createWorkflowRunsDatabase({
				users: [{ email, plan, stable_user_id: userId }],
			}),
		)
	const planRun = (plan: string, idempotencyKey: string) =>
		createDynamicCallableWorkflow({
			env: planEnv(plan),
			userId: ownerIdFromStored(userId),
			lineage: sessionRequestLineage(userId),
			userEmail: email,
			body: { code: inlineCode, runAt, idempotencyKey },
		})

	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId, count: proLimit })
	runRecordMocks.reserveWorkflowProjectionSlot.mockClear()
	runRecordMocks.deleteWorkflowProjectionIfCreating.mockClear()
	await expectDenied(planRun('pro', 'plan-limit-key'), {
		plan: 'pro',
		limit: proLimit,
		userId,
	})

	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId, count: proLimit - 1 })
	expect((await planRun('pro', 'plan-limit-allowed-key')).ok).toBe(true)

	// Background workflow callers carry the real account email, so a max-plan
	// account is not wrongly capped at the free concurrent limit.
	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId, count: freeLimit })
	expect((await planRun('max', 'plan-limit-blank-email-max-key')).ok).toBe(true)
})

test('listWorkflowRunsForUser returns recent workflow statuses', async () => {
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const env = createWorkflowEnv(binding)
	const created = await createInline(env, {
		runAt: '2026-05-03T12:34:56.000Z',
		idempotencyKey: 'inline-key',
	})

	runRecordMocks.upsertWorkflowProjection.mockClear()
	const listed = {
		id: created.id,
		status: 'queued',
		idempotencyKey: 'inline-key',
	}
	const list = () =>
		listWorkflowRunsForUser({
			env,
			userId: ownerIdFromStored('user-1'),
			limit: 10,
		})
	expect(await list()).toEqual([
		expect.objectContaining({ ...listed, sourceType: 'inline' }),
	])
	expect(runRecordMocks.upsertWorkflowProjection).not.toHaveBeenCalled()
	// A vanished engine instance does not rewrite the listed status.
	binding.instances.delete(created.id)
	expect(await list()).toEqual([expect.objectContaining(listed)])
})

test('DynamicCallableWorkflowBase records workflow_run usage on terminal transitions', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const cases = [
		{
			key: 'usage-metering-success',
			code: 'export default async function main(p){ return { ok: true, p }; }',
			outcome: 'success',
		},
		{
			key: 'usage-metering-failure',
			code: 'export default async function main(){ throw new Error("workflow failed"); }',
			outcome: 'error',
		},
	] as const

	vi.useFakeTimers()
	try {
		for (const { key, code, outcome } of cases) {
			recordUsageSpy.mockClear()
			runRecordMocks.resetProjections()
			const binding = createStatefulWorkflowBinding()
			const env = createWorkflowEnv(binding)
			vi.setSystemTime(new Date('2026-05-03T12:34:00.000Z'))
			const created = await createDynamicCallableWorkflow({
				env,
				userId: ownerIdFromStored('user-1'),
				lineage: sessionRequestLineage('user-1'),
				packageContext: null,
				body: {
					code,
					runAt: '2026-05-03T12:34:56.000Z',
					idempotencyKey: key,
					params: { greeting: 'hello' },
				},
			})
			if (outcome === 'success') {
				invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
					result: { ok: true, p: { greeting: 'hello' } },
					logs: [],
				})
			} else {
				invocationMocks.runModuleWithRegistry.mockRejectedValueOnce(
					new Error('workflow failed'),
				)
			}
			vi.setSystemTime(new Date('2026-05-03T12:35:00.000Z'))
			const run = new DynamicCallableWorkflowBase(
				{} as ExecutionContext,
				env,
			).run(queuedPayload(binding, created.id), createInlineStep())
			if (outcome === 'success') {
				await expect(run).resolves.toEqual({
					ok: true,
					p: { greeting: 'hello' },
				})
			} else {
				await expect(run).rejects.toThrow('workflow failed')
				expect(findRun(created.id)).toMatchObject({
					status: 'errored',
					lastError: 'workflow failed',
				})
			}
			expect(recordUsageSpy).toHaveBeenCalledTimes(1)
			expect(recordUsageSpy).toHaveBeenCalledWith(env, {
				userId: ownerIdFromStored('user-1'),
				actorUserId: '',
				automationSource: 'schedule',
				eventType: 'workflow_run',
				entityId: created.id,
				durationMs: expect.any(Number),
				outcome,
				...(outcome === 'error' ? { errorName: 'Error' } : {}),
			})
			expect(
				recordUsageSpy.mock.calls[0]?.[1]?.durationMs,
			).toBeGreaterThanOrEqual(0)
		}
	} finally {
		vi.useRealTimers()
		recordUsageSpy.mockRestore()
	}
})

test('workflow_run usage is recorded once across replays and never on failed terminal status writes', async () => {
	runRecordMocks.resetProjections()
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	function createReplayableStep() {
		const cachedResults = new Map<string, unknown>()
		return {
			sleepUntil: vi.fn(),
			do: vi.fn(
				async (name: string, _config: unknown, callback: () => unknown) => {
					if (cachedResults.has(name)) return cachedResults.get(name)
					const value = await callback()
					cachedResults.set(name, value)
					return value
				},
			),
		} as unknown as WorkflowStep
	}
	const binding = createStatefulWorkflowBinding()
	const env = createWorkflowEnv(binding)
	const queueInline = async (idempotencyKey: string) => {
		const created = await createDynamicCallableWorkflow({
			env,
			userId: ownerIdFromStored('user-1'),
			lineage: sessionRequestLineage('user-1'),
			packageContext: null,
			body: {
				code: 'export default async function main(){ return { ok: true }; }',
				runAt: '2026-05-03T12:34:56.000Z',
				idempotencyKey,
			},
		})
		return { created, event: queuedPayload(binding, created.id) }
	}
	invocationMocks.runModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)

	try {
		// First entry plus a replay: completed steps return cached results, so the
		// usage event is recorded exactly once.
		const { created, event } = await queueInline('usage-metering-replay')
		const replayableStep = createReplayableStep()
		await workflow.run(event, replayableStep)
		await workflow.run(event, replayableStep)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				eventType: 'workflow_run',
				entityId: created.id,
				outcome: 'success',
			}),
		)

		// A successful execution whose authoritative RunLog terminal projection
		// write fails must not be recorded as usage (and is not recorded at all
		// until the terminal transition succeeds on a later replay).
		recordUsageSpy.mockClear()
		runRecordMocks.resetProjections()
		const statusFailure = await queueInline(
			'usage-metering-status-write-failure',
		)
		const applyUpsert =
			runRecordMocks.upsertWorkflowProjection.getMockImplementation()!
		runRecordMocks.upsertWorkflowProjection.mockImplementation(
			async (input) => {
				if (input.projection.status === 'complete') {
					throw new Error('terminal status write failed')
				}
				return await applyUpsert(input)
			},
		)
		await expect(
			workflow.run(statusFailure.event, createReplayableStep()),
		).rejects.toThrow('terminal status write failed')
		expect(recordUsageSpy).not.toHaveBeenCalled()
	} finally {
		recordUsageSpy.mockRestore()
	}
})
