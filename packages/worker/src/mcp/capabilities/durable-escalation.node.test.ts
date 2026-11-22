import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	EntitlementLimitError,
	isEntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import {
	buildCallerScopedIdempotencyKey,
	dispatchDurableRun,
} from './durable-escalation.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import type {
	WorkflowProjectionRecord,
	WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import type * as PackageWorkflows from '#worker/package-runtime/package-workflows.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'

const mockModule = vi.hoisted(() => ({
	createDynamicCallableWorkflow: vi.fn(),
}))

const runRecordMocks = vi.hoisted(() => {
	const projectionsByUser = new Map<
		string,
		Map<string, WorkflowProjectionRecord>
	>()

	function userStore(userId: string) {
		let store = projectionsByUser.get(userId)
		if (!store) {
			store = new Map()
			projectionsByUser.set(userId, store)
		}
		return store
	}

	function toRecord(
		input: WorkflowProjectionUpsertInput,
	): WorkflowProjectionRecord {
		const now = new Date().toISOString()
		return {
			id: input.id,
			progress: null,
			bindingName: input.bindingName,
			sourceType: input.sourceType,
			packageId: input.packageId ?? null,
			kodyId: input.kodyId ?? null,
			sourceId: input.sourceId ?? null,
			workflowName: input.workflowName,
			exportName: input.exportName ?? null,
			idempotencyKey: input.idempotencyKey,
			runAt: input.runAt,
			planDate: input.planDate ?? null,
			status: input.status ?? null,
			createdAt: input.createdAt?.trim() || now,
			updatedAt: input.updatedAt?.trim() || now,
			completedAt: input.completedAt ?? null,
			lastError: input.lastError ?? null,
			enqueuedCommit: input.enqueuedCommit ?? null,
			sourceRevision: input.sourceRevision ?? null,
		}
	}

	return {
		resetProjections() {
			projectionsByUser.clear()
		},
		seed(userId: string, projection: WorkflowProjectionUpsertInput) {
			userStore(userId).set(projection.id, toRecord(projection))
		},
		upsertWorkflowProjection: vi.fn(
			async (input: {
				userId: string
				projection: WorkflowProjectionUpsertInput
			}) => {
				userStore(input.userId).set(
					input.projection.id,
					toRecord(input.projection),
				)
				return { ok: true as const }
			},
		),
		findWorkflowProjectionByIdempotencyKey: vi.fn(
			async (input: {
				userId: string
				idempotencyKey: string
				bindingName?: string | null
			}) =>
				[...userStore(input.userId).values()]
					.filter(
						(row) =>
							row.idempotencyKey === input.idempotencyKey &&
							row.status !== 'creating' &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) =>
						right.createdAt.localeCompare(left.createdAt),
					)[0] ?? null,
		),
		findWorkflowProjectionByBindingIdempotencyKey: vi.fn(
			async (input: {
				userId: string
				bindingName: string
				idempotencyKey: string
			}) =>
				[...userStore(input.userId).values()]
					.filter(
						(row) =>
							row.bindingName === input.bindingName &&
							row.idempotencyKey === input.idempotencyKey,
					)
					.sort((left, right) =>
						right.createdAt.localeCompare(left.createdAt),
					)[0] ?? null,
		),
	}
})

vi.mock(
	'#worker/package-runtime/package-workflows.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof PackageWorkflows>()),
		createDynamicCallableWorkflow: (...args: Array<unknown>) =>
			mockModule.createDynamicCallableWorkflow(...args),
	}),
)

vi.mock('#worker/run-records/service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof RunRecordsServiceModule>()),
	upsertWorkflowProjection: (input: never) =>
		runRecordMocks.upsertWorkflowProjection(input),
	findWorkflowProjectionByIdempotencyKey: (input: never) =>
		runRecordMocks.findWorkflowProjectionByIdempotencyKey(input),
	findWorkflowProjectionByBindingIdempotencyKey: (input: never) =>
		runRecordMocks.findWorkflowProjectionByBindingIdempotencyKey(input),
}))

const projectionBindingName = 'DYNAMIC_CALLABLE_WORKFLOWS'
const workflowName = 'packagePublishExternalPush'
const publishParts = [
	workflowName,
	'owner-platform',
	'package-1',
	'commit-new',
] as const

function envStub() {
	return {
		// Create still types APP_DB for entitlement/plan lookup; unused here
		// because createDynamicCallableWorkflow is mocked.
		APP_DB: undefined as unknown as D1Database,
		DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
}

type EscalationInput = Parameters<typeof dispatchDurableRun>[0]

function escalate(overrides: Partial<EscalationInput> = {}) {
	return dispatchDurableRun({
		env: envStub(),
		userId: ownerIdFromStored('user-1'),
		idempotencyParts: publishParts,
		workflowName,
		durableCode: 'export default async function main() { return null }',
		...overrides,
	} as EscalationInput)
}

function created(id: string, status = 'queued') {
	return {
		ok: true,
		id,
		workflow_name: workflowName,
		source_type: 'inline',
		run_at: '2026-07-27T00:00:00.000Z',
		plan_date: '2026-07-27',
		status,
	}
}

function seedProjection(
	userId: string,
	id: string,
	idempotencyKey: string,
	status: string,
	createdAt?: string,
) {
	runRecordMocks.seed(userId, {
		id,
		createdAt,
		bindingName: projectionBindingName,
		sourceType: 'inline',
		workflowName,
		idempotencyKey,
		runAt: '2026-07-27T00:00:00.000Z',
		status,
	})
}

const keyFor = (userId: string, parts: ReadonlyArray<string> = publishParts) =>
	buildCallerScopedIdempotencyKey({ userId: ownerIdFromStored(userId), parts })

test('dispatches once and reuses an active run for the same caller', async () => {
	runRecordMocks.resetProjections()
	mockModule.createDynamicCallableWorkflow.mockResolvedValue(
		created('dynwf-escalated-1'),
	)
	const expectedKey = keyFor('user-1')

	const first = await escalate({
		userEmail: 'user@example.com',
		durableCode:
			'import { kody } from "kody:runtime"; export default async function main(p) { return await kody.packagePublishExternalPush(p) }',
		durableParams: { package_id: 'pkg-1' },
		packageContext: {
			packageId: 'pkg-1',
			kodyId: 'pkg-one',
			sourceId: 'src-1',
		},
		enqueuedCommit: 'commit-new',
	})
	expect(first).toMatchObject({
		kind: 'dispatched',
		handle: { workflow_id: 'dynwf-escalated-1', idempotency_key: expectedKey },
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(1)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'pkg-one',
				sourceId: 'src-1',
			},
			enqueuedCommit: 'commit-new',
			body: expect.objectContaining({
				idempotencyKey: expectedKey,
			}),
		}),
	)

	mockModule.createDynamicCallableWorkflow.mockClear()
	seedProjection('user-1', 'dynwf-escalated-1', expectedKey, 'running')
	await expect(escalate()).resolves.toMatchObject({
		kind: 'dispatched',
		handle: {
			workflow_id: 'dynwf-escalated-1',
			idempotency_key: expectedKey,
			run_status: 'running',
		},
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(
		runRecordMocks.findWorkflowProjectionByIdempotencyKey,
	).toHaveBeenCalled()
})

test('mid-creation workflow projection rows are treated as already dispatched', async () => {
	runRecordMocks.resetProjections()
	const expectedKey = keyFor('user-1')
	seedProjection(
		'user-1',
		'dynwf-creating-1',
		expectedKey,
		creatingWorkflowProjectionStatus,
	)

	await expect(escalate()).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-creating-1',
			idempotency_key: expectedKey,
			run_status: 'creating',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(
		runRecordMocks.findWorkflowProjectionByBindingIdempotencyKey,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			idempotencyKey: expectedKey,
		}),
	)
})

test('different acting callers get non-colliding dedupe; same caller still reuses', async () => {
	runRecordMocks.resetProjections()
	const delegateAKey = keyFor('delegate-a')
	const delegateBKey = keyFor('delegate-b')
	expect(delegateAKey).toBe(
		'delegate-a:packagePublishExternalPush:owner-platform:package-1:commit-new',
	)
	expect(delegateBKey).toBe(
		'delegate-b:packagePublishExternalPush:owner-platform:package-1:commit-new',
	)
	mockModule.createDynamicCallableWorkflow
		.mockResolvedValueOnce(created('dynwf-delegate-a'))
		.mockResolvedValueOnce(created('dynwf-delegate-b'))

	await expect(
		escalate({ userId: ownerIdFromStored('delegate-a') }),
	).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-delegate-a',
			idempotency_key: delegateAKey,
		}),
	})
	seedProjection('delegate-a', 'dynwf-delegate-a', delegateAKey, 'running')

	// A second acting caller must not reuse the first caller's active row even
	// when owner/package/commit parts match (projections are user-scoped).
	await expect(
		escalate({ userId: ownerIdFromStored('delegate-b') }),
	).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-delegate-b',
			idempotency_key: delegateBKey,
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(2)
	for (const [call, userId, idempotencyKey] of [
		[1, 'delegate-a', delegateAKey],
		[2, 'delegate-b', delegateBKey],
	] as const) {
		expect(mockModule.createDynamicCallableWorkflow).toHaveBeenNthCalledWith(
			call,
			expect.objectContaining({
				userId,
				body: expect.objectContaining({ idempotencyKey }),
			}),
		)
	}

	mockModule.createDynamicCallableWorkflow.mockClear()
	seedProjection('delegate-b', 'dynwf-delegate-b', delegateBKey, 'running')
	await expect(
		escalate({ userId: ownerIdFromStored('delegate-a') }),
	).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-delegate-a',
			idempotency_key: delegateAKey,
			run_status: 'running',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
})

test('dispatchDurableRun never throws and reports why it could not dispatch', async () => {
	const emptyParts = await escalate({ idempotencyParts: ['   ', ''] })
	expect(emptyParts).toEqual({
		kind: 'failed',
		error: expect.any(Error),
	})
	if (emptyParts.kind !== 'failed') {
		throw new Error('expected failed')
	}
	expect(getErrorMessage(emptyParts.error)).toBe(
		'Durable escalation requires at least one idempotency part.',
	)

	const dispatchError = new Error('Missing DYNAMIC_CALLABLE_WORKFLOWS binding.')
	mockModule.createDynamicCallableWorkflow.mockRejectedValueOnce(dispatchError)
	await expect(
		escalate({ idempotencyParts: ['publish', 'pkg-1', 'dispatch-fail'] }),
	).resolves.toEqual({
		kind: 'failed',
		error: dispatchError,
	})

	const entitlementError = new EntitlementLimitError({
		resource: 'concurrent_workflows',
		plan: 'pro',
		limit: 5,
		current: 5,
		upgradeHint:
			'Wait for a run to finish, or upgrade your plan at /@<slug>/-/billing.',
	})
	mockModule.createDynamicCallableWorkflow.mockRejectedValueOnce(
		entitlementError,
	)
	const entitlementOutcome = await escalate({
		idempotencyParts: ['publish', 'pkg-1', 'entitlement'],
	})
	expect(entitlementOutcome).toEqual({
		kind: 'failed',
		error: entitlementError,
	})
	if (entitlementOutcome.kind !== 'failed') {
		throw new Error('expected failed')
	}
	expect(isEntitlementLimitError(entitlementOutcome.error)).toBe(true)
})

test('an errored run is re-dispatched once as a fresh run; running and complete runs dedupe', async () => {
	runRecordMocks.resetProjections()
	mockModule.createDynamicCallableWorkflow.mockReset()
	const expectedKey = keyFor('user-1')
	seedProjection('user-1', 'dynwf-errored-1', expectedKey, 'errored')
	mockModule.createDynamicCallableWorkflow
		.mockResolvedValueOnce(created('dynwf-errored-1', 'errored'))
		.mockResolvedValueOnce(created('dynwf-retry-1', 'running'))
	await expect(escalate()).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-retry-1',
			run_status: 'running',
			idempotency_key: expectedKey,
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(2)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenNthCalledWith(
		1,
		expect.not.objectContaining({ rerunOf: expect.anything() }),
	)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			rerunOf: 'dynwf-errored-1',
			body: expect.objectContaining({ idempotencyKey: expectedKey }),
		}),
	)

	// The rerun is now the latest run for the key, so it dedupes.
	mockModule.createDynamicCallableWorkflow.mockClear()
	seedProjection(
		'user-1',
		'dynwf-retry-1',
		expectedKey,
		'running',
		'2099-01-01T00:00:00.000Z',
	)
	await expect(escalate()).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-retry-1',
			run_status: 'running',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()

	mockModule.createDynamicCallableWorkflow.mockResolvedValueOnce(
		created('dynwf-complete-1', 'complete'),
	)
	const completeParts = [...publishParts, 'complete-replay']
	await expect(escalate({ idempotencyParts: completeParts })).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-complete-1',
			run_status: 'complete',
			idempotency_key: keyFor('user-1', completeParts),
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(1)
})

test('a re-dispatched run that also ended dead surfaces both runs in the error', async () => {
	runRecordMocks.resetProjections()
	mockModule.createDynamicCallableWorkflow.mockReset()
	mockModule.createDynamicCallableWorkflow
		.mockResolvedValueOnce(created('dynwf-errored-1', 'errored'))
		.mockResolvedValueOnce(created('dynwf-errored-2', 'terminated'))
	const outcome = await escalate()
	if (outcome.kind !== 'failed') {
		throw new Error('expected failed')
	}
	expect(getErrorMessage(outcome.error)).toBe(
		'A previous durable run "dynwf-errored-1" for this operation ended with status "errored", and its re-dispatched run "dynwf-errored-2" ended with status "terminated".',
	)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(2)
})

test('rerunComplete starts a new run when the same operation already completed', async () => {
	runRecordMocks.resetProjections()
	mockModule.createDynamicCallableWorkflow.mockReset()
	const parts = ['packageCheck', 'v1', 'etag-1', 'pcu_1']
	seedProjection('user-1', 'dynwf-check-1', keyFor('user-1', parts), 'complete')
	mockModule.createDynamicCallableWorkflow
		.mockResolvedValueOnce(created('dynwf-check-1', 'complete'))
		.mockResolvedValueOnce(created('dynwf-check-2', 'queued'))

	await expect(
		escalate({ idempotencyParts: parts, rerunComplete: true }),
	).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-check-2',
			run_status: 'queued',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ rerunOf: 'dynwf-check-1' }),
	)
})
