import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestLineage } from '#worker/test-support/request-context.ts'
import { type WorkflowProjectionUpsertInput } from '#worker/run-records/service.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import {
	packageWorkflowsRunRecordMocks as runRecordMocks,
	createWorkflowRunsDatabase,
} from '#worker/test-support/package-workflows.ts'
import {
	cancelActiveWorkflowRunsForUser,
	cancelWorkflowRunForUser,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	listWorkflowRunsForUser,
} from './package-workflows.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'

vi.mock('#worker/run-records/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RunRecordsServiceModule>()
	return {
		...actual,
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
	}
})

type FakeInstanceOptions = {
	status?: string
	terminateThrows?: Error | null
	statusAfterTerminate?: string
	onTerminate?: () => void | Promise<void>
}

/** Resets the shared RunLog projection store and returns a binding whose instances record terminate calls. */
function createCancelTestEnv() {
	runRecordMocks.resetProjections()
	const instances = new Map<string, WorkflowInstanceCreateOptions>()
	const terminateCalls: Array<string> = []
	const missingIds = new Set<string>()
	const perInstance = new Map<string, FakeInstanceOptions>()

	function createInstanceHandle(id: string) {
		const knobs = perInstance.get(id) ?? {}
		return {
			id,
			status: async () => ({
				status: knobs.statusAfterTerminate ?? knobs.status ?? 'queued',
			}),
			terminate: vi.fn(async () => {
				terminateCalls.push(id)
				if (knobs.onTerminate) await knobs.onTerminate()
				if (knobs.terminateThrows) throw knobs.terminateThrows
				knobs.status = 'terminated'
				knobs.statusAfterTerminate = 'terminated'
			}),
		}
	}
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (!input.id) throw new Error('Expected a workflow instance id.')
		if (instances.has(input.id)) {
			throw new Error('Workflow instance already exists')
		}
		instances.set(input.id, input)
		return createInstanceHandle(input.id)
	})
	const get = vi.fn(async (id: string) => {
		if (missingIds.has(id) || !instances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return createInstanceHandle(id)
	})
	const env = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: { get, create } as unknown as Workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
	return {
		env,
		binding: { get, create, terminateCalls, missingIds, perInstance },
		createInline: (
			idempotencyKey: string,
			runAt = '2026-05-03T12:34:56.000Z',
		) =>
			createDynamicCallableWorkflow({
				env,
				userId: ownerIdFromStored('user-1'),
				lineage: sessionRequestLineage('user-1'),
				packageContext: null,
				body: {
					code: 'export default async function main() { return { ok: true } }',
					idempotencyKey,
					runAt,
				},
			}),
		cancel: (workflowRunId: string, userId = 'user-1') =>
			cancelWorkflowRunForUser({
				env,
				userId: ownerIdFromStored(userId),
				workflowRunId,
			}),
		seedProjection: (id: string, idempotencyKey: string, status: string) =>
			runRecordMocks.upsertWorkflowProjection({
				env,
				userId: ownerIdFromStored('user-1'),
				projection: {
					id,
					bindingName: dynamicCallableWorkflowsBindingName,
					sourceType: 'inline',
					workflowName: 'inline-code',
					idempotencyKey,
					runAt: '2026-05-03T12:34:56.000Z',
					planDate: '2026-05-03',
					status,
					createdAt: '2026-05-03T12:34:56.000Z',
					updatedAt: '2026-05-03T12:34:56.000Z',
				},
			}),
	}
}

const findRun = (id: string) =>
	runRecordMocks.listForUser('user-1').find((row) => row.id === id)

const cannotTerminate = 'Instance is in a state that cannot be terminated'

test('cancelWorkflowRunForUser cancels a queued run and is idempotent', async () => {
	const { env, binding, createInline, cancel } = createCancelTestEnv()
	const created = await createInline('cancel-idempotent-key')
	expect(created.status).toBe('queued')
	expect(binding.create).toHaveBeenCalledTimes(1)

	expect(await cancel(created.id)).toMatchObject({
		outcome: 'cancelled',
		run: {
			id: created.id,
			status: 'cancelled',
			completedAt: expect.any(String),
		},
	})
	expect(binding.terminateCalls).toEqual([created.id])
	expect(findRun(created.id)).toMatchObject({
		status: 'cancelled',
		completedAt: expect.any(String),
		bindingName: dynamicCallableWorkflowsBindingName,
	})
	expect(
		await listWorkflowRunsForUser({
			env,
			userId: ownerIdFromStored('user-1'),
			limit: 10,
		}),
	).toEqual([expect.objectContaining({ id: created.id, status: 'cancelled' })])

	expect(await cancel(created.id)).toMatchObject({
		outcome: 'already_terminal',
		run: { id: created.id, status: 'cancelled' },
	})
	expect(binding.terminateCalls).toEqual([created.id])
})

test('cancelWorkflowRunForUser enforces user isolation', async () => {
	const { binding, createInline, cancel } = createCancelTestEnv()
	const created = await createInline('isolation-key')
	const beforeProjection = findRun(created.id)
	expect(beforeProjection?.status).toBe('queued')
	binding.get.mockClear()

	expect(await cancel(created.id, 'user-2')).toEqual({ outcome: 'not_found' })
	expect(binding.terminateCalls).toEqual([])
	expect(binding.get).not.toHaveBeenCalled()
	expect(findRun(created.id)).toEqual(beforeProjection)
})

test('a cancelled run keeps single-flighting its idempotency key', async () => {
	const { binding, createInline, cancel } = createCancelTestEnv()
	const created = await createInline('single-flight-key')
	await cancel(created.id)
	expect(binding.create).toHaveBeenCalledTimes(1)

	const replay = await createInline(
		'single-flight-key',
		'2026-05-03T12:35:56.000Z',
	)
	expect(replay.id).toBe(created.id)
	expect(replay.status).toBe('cancelled')
	expect(binding.create).toHaveBeenCalledTimes(1)

	const fresh = await createInline(
		'single-flight-key-other',
		'2026-05-03T12:36:56.000Z',
	)
	expect(fresh.id).not.toBe(created.id)
	expect(fresh.status).toBe('queued')
	expect(binding.create).toHaveBeenCalledTimes(2)
})

test('cancel races with a run that finishes first', async () => {
	const completeRace = createCancelTestEnv()
	const completeCreated = await completeRace.createInline('race-complete-key')
	completeRace.binding.perInstance.set(completeCreated.id, {
		terminateThrows: new Error(cannotTerminate),
		statusAfterTerminate: 'complete',
	})
	expect(await completeRace.cancel(completeCreated.id)).toMatchObject({
		outcome: 'already_terminal',
		run: {
			id: completeCreated.id,
			status: 'complete',
			completedAt: expect.any(String),
		},
	})
	expect(findRun(completeCreated.id)).toMatchObject({
		status: 'complete',
		completedAt: expect.any(String),
	})

	const runningRace = createCancelTestEnv()
	const runningCreated = await runningRace.createInline('race-running-key')
	runningRace.binding.perInstance.set(runningCreated.id, {
		terminateThrows: new Error(cannotTerminate),
		statusAfterTerminate: 'running',
	})
	await expect(runningRace.cancel(runningCreated.id)).rejects.toThrow(
		cannotTerminate,
	)
	expect(findRun(runningCreated.id)).toMatchObject({
		status: 'queued',
		completedAt: null,
	})
})

test('cancel projection loses to a concurrent complete write', async () => {
	const { env, binding, createInline, cancel } = createCancelTestEnv()
	const created = await createInline('guarded-projection-key')
	binding.perInstance.set(created.id, {
		onTerminate: async () => {
			const existing = findRun(created.id)
			if (!existing) throw new Error('Expected projection before race write.')
			// Must be >= existing.updatedAt so monotonic upsert accepts the race.
			const completedAt = new Date(
				Math.max(Date.parse(existing.updatedAt) + 1, Date.now()),
			).toISOString()
			await runRecordMocks.upsertWorkflowProjection({
				env,
				userId: ownerIdFromStored('user-1'),
				projection: {
					...existing,
					status: 'complete',
					completedAt,
					updatedAt: completedAt,
				},
			})
		},
	})

	expect(await cancel(created.id)).toMatchObject({
		outcome: 'already_terminal',
		run: {
			id: created.id,
			status: 'complete',
			completedAt: expect.any(String),
		},
	})
	expect(findRun(created.id)).toMatchObject({
		status: 'complete',
		completedAt: expect.any(String),
	})
})

test('cancelling a run whose engine instance is missing projects cancelled unless it is still creating', async () => {
	const { binding, cancel, seedProjection } = createCancelTestEnv()
	await seedProjection(
		'dynwf-missing-instance',
		'missing-instance-key',
		'queued',
	)
	binding.missingIds.add('dynwf-missing-instance')

	expect(await cancel('dynwf-missing-instance')).toMatchObject({
		outcome: 'cancelled',
		run: { id: 'dynwf-missing-instance', status: 'cancelled' },
	})
	expect(findRun('dynwf-missing-instance')).toMatchObject({
		status: 'cancelled',
		completedAt: expect.any(String),
		bindingName: dynamicCallableWorkflowsBindingName,
	})

	await seedProjection(
		'dynwf-creating-race',
		'creating-race-key',
		creatingWorkflowProjectionStatus,
	)
	binding.missingIds.add('dynwf-creating-race')
	await expect(cancel('dynwf-creating-race')).rejects.toThrow(
		/still being created; retry cancellation shortly/,
	)
	expect(binding.terminateCalls).toEqual([])
	expect(findRun('dynwf-creating-race')).toMatchObject({
		status: creatingWorkflowProjectionStatus,
		completedAt: null,
	})
})

test('cancelActiveWorkflowRunsForUser terminates every active run for one user only', async () => {
	const { env, binding, createInline, seedProjection } = createCancelTestEnv()
	const queued = await createInline('delete-active-queued')
	await seedProjection('retained-running', 'delete-retained-running', 'running')
	await seedProjection('already-complete', 'delete-complete', 'complete')
	await runRecordMocks.upsertWorkflowProjection({
		env,
		userId: ownerIdFromStored('user-2'),
		projection: {
			id: 'other-user-queued',
			bindingName: dynamicCallableWorkflowsBindingName,
			sourceType: 'inline',
			workflowName: 'inline-code',
			idempotencyKey: 'other-user-queued',
			runAt: '2026-05-03T12:34:56.000Z',
			status: 'queued',
		},
	})

	expect(
		await cancelActiveWorkflowRunsForUser({
			env,
			userId: ownerIdFromStored('user-1'),
		}),
	).toBe(2)
	expect(binding.terminateCalls).toEqual([queued.id])
	expect(findRun(queued.id)?.status).toBe('cancelled')
	expect(findRun('retained-running')?.status).toBe('cancelled')
	expect(findRun('already-complete')?.status).toBe('complete')
	expect(runRecordMocks.listForUser('user-2')).toEqual([
		expect.objectContaining({ id: 'other-user-queued', status: 'queued' }),
	])
})

test('cancelActiveWorkflowRunsForUser can stop only the runs one person started', async () => {
	const { env, binding, seedProjection } = createCancelTestEnv()
	const seedStartedBy = (id: string, startedByUserId: string | null) =>
		runRecordMocks.upsertWorkflowProjection({
			env,
			userId: ownerIdFromStored('user-1'),
			projection: {
				id,
				bindingName: dynamicCallableWorkflowsBindingName,
				sourceType: 'inline',
				workflowName: 'inline-code',
				idempotencyKey: id,
				runAt: '2026-05-03T12:34:56.000Z',
				status: 'queued',
				startedByUserId,
			},
		})
	await seedStartedBy('started-by-member', 'member-1')
	await seedStartedBy('started-by-owner', 'owner-1')
	await seedProjection('started-by-platform', 'started-by-platform', 'running')

	expect(
		await cancelActiveWorkflowRunsForUser({
			env,
			userId: ownerIdFromStored('user-1'),
			startedByUserId: 'member-1',
		}),
	).toBe(1)
	expect(findRun('started-by-member')?.status).toBe('cancelled')
	expect(findRun('started-by-owner')?.status).toBe('queued')
	expect(findRun('started-by-platform')?.status).toBe('running')
	expect(binding.terminateCalls).toEqual([])
})
