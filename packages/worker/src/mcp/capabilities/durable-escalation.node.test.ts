import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	EntitlementLimitError,
	isEntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import {
	buildCallerScopedIdempotencyKey,
	defaultDurableEscalationBudgetMs,
	runWithDurableEscalation,
} from './durable-escalation.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
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
		releaseWorkflowProjectionIdempotencyKey: vi.fn(
			async (input: { userId: string; id: string }) => {
				const store = userStore(input.userId)
				const existing = store.get(input.id)
				if (!existing) {
					return { released: false, previousKey: null }
				}
				if (existing.idempotencyKey.startsWith('released:')) {
					return { released: false, previousKey: existing.idempotencyKey }
				}
				const previousKey = existing.idempotencyKey
				store.set(input.id, {
					...existing,
					idempotencyKey: `released:${input.id}`,
					updatedAt: new Date().toISOString(),
				})
				return { released: true, previousKey }
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
						left.createdAt.localeCompare(right.createdAt),
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
						left.createdAt.localeCompare(right.createdAt),
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
	releaseWorkflowProjectionIdempotencyKey: (input: never) =>
		runRecordMocks.releaseWorkflowProjectionIdempotencyKey(input),
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

function hangUntilAborted() {
	return vi.fn(
		async (signal: AbortSignal) =>
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => reject(new DOMException('Aborted', 'AbortError')),
					{ once: true },
				)
			}),
	)
}

type EscalationInput = Parameters<typeof runWithDurableEscalation>[0]

function escalate(overrides: Partial<EscalationInput> = {}) {
	return runWithDurableEscalation({
		env: envStub(),
		userId: ownerIdFromStored('user-1'),
		idempotencyParts: publishParts,
		workflowName,
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted(),
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
) {
	runRecordMocks.seed(userId, {
		id,
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

test('runWithDurableEscalation returns the inline result when work finishes within budget', async () => {
	const run = vi.fn(async (_signal: AbortSignal) => ({
		status: 'published',
		commit: 'abc',
	}))
	const outcome = await escalate({
		idempotencyParts: ['publish', 'pkg-1', 'commit-1'],
		budgetMs: 5_000,
		run,
	})
	expect(outcome).toMatchObject({ kind: 'completed' })
	expect(run).toHaveBeenCalledTimes(1)
	expect(run.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(defaultDurableEscalationBudgetMs).toBeLessThanOrEqual(40_000)
})

test('runWithDurableEscalation dispatches once on budget exhaustion and reuses an active run for the same caller', async () => {
	runRecordMocks.resetProjections()
	mockModule.createDynamicCallableWorkflow.mockResolvedValue(
		created('dynwf-escalated-1'),
	)
	const run = hangUntilAborted()
	const expectedKey = keyFor('user-1')

	const first = await escalate({
		userEmail: 'user@example.com',
		durableCode:
			'import { kody } from "kody:runtime"; export default async function main(p) { return await kody.packagePublishExternalPush(p) }',
		durableParams: { package_id: 'pkg-1' },
		run,
	})
	expect(first).toMatchObject({
		kind: 'dispatched',
		handle: { workflow_id: 'dynwf-escalated-1', idempotency_key: expectedKey },
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(1)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			body: expect.objectContaining({
				idempotencyKey: expectedKey,
			}),
		}),
	)

	mockModule.createDynamicCallableWorkflow.mockClear()
	seedProjection('user-1', 'dynwf-escalated-1', expectedKey, 'running')
	await expect(escalate({ run })).resolves.toMatchObject({
		kind: 'dispatched',
		handle: {
			workflow_id: 'dynwf-escalated-1',
			idempotency_key: expectedKey,
			run_status: 'running',
		},
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(run).toHaveBeenCalledTimes(1)
	expect(
		runRecordMocks.findWorkflowProjectionByIdempotencyKey,
	).toHaveBeenCalled()
})

test('mid-creation workflow projection rows are treated as already dispatched', async () => {
	runRecordMocks.resetProjections()
	const run = hangUntilAborted()
	const expectedKey = keyFor('user-1')
	seedProjection(
		'user-1',
		'dynwf-creating-1',
		expectedKey,
		creatingWorkflowProjectionStatus,
	)

	await expect(escalate({ run })).resolves.toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-creating-1',
			idempotency_key: expectedKey,
			run_status: 'creating',
		}),
	})
	expect(run).not.toHaveBeenCalled()
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

test('runWithDurableEscalation never throws and preserves original failures', async () => {
	const checksError = new Error('checks blew up')
	await expect(
		escalate({
			idempotencyParts: ['publish', 'pkg-1', 'fail'],
			budgetMs: 5_000,
			run: async () => {
				throw checksError
			},
		}),
	).resolves.toEqual({ kind: 'failed', error: checksError })
	const emptyParts = await escalate({
		idempotencyParts: ['   ', ''],
		budgetMs: undefined,
		run: async () => ({ ok: true }),
	})
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
	mockModule.createDynamicCallableWorkflow.mockRejectedValue(dispatchError)
	await expect(
		escalate({
			idempotencyParts: ['publish', 'pkg-1', 'dispatch-fail'],
			budgetMs: 20,
		}),
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
	const entitlementOutcome = await escalate({
		idempotencyParts: ['publish', 'pkg-1', 'entitlement'],
		budgetMs: 5_000,
		run: async () => {
			throw entitlementError
		},
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

test('budget exhaustion releases a dead terminal key and re-dispatches once', async () => {
	runRecordMocks.resetProjections()
	const expectedKey = keyFor('user-1')
	seedProjection('user-1', 'dynwf-cancelled-1', expectedKey, 'cancelled')
	mockModule.createDynamicCallableWorkflow
		.mockResolvedValueOnce(created('dynwf-cancelled-1', 'cancelled'))
		.mockResolvedValueOnce(created('dynwf-retry-1', 'queued'))
	const cancelledOutcome = await escalate()
	expect(cancelledOutcome).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-retry-1',
			run_status: 'queued',
			idempotency_key: expectedKey,
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(2)
	expect(
		runRecordMocks.releaseWorkflowProjectionIdempotencyKey,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			id: 'dynwf-cancelled-1',
		}),
	)

	mockModule.createDynamicCallableWorkflow.mockClear()
	runRecordMocks.releaseWorkflowProjectionIdempotencyKey.mockClear()
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
	expect(
		runRecordMocks.releaseWorkflowProjectionIdempotencyKey,
	).not.toHaveBeenCalled()
})

test('budget abort dispatches while the inline attempt is still in flight', async () => {
	const events: Array<string> = []
	mockModule.createDynamicCallableWorkflow.mockImplementation(async () => {
		events.push('dispatched')
		return created('dynwf-overlap-1')
	})

	let releaseInline = null as (() => void) | null
	const outcome = await escalate({
		idempotencyParts: ['publish', 'pkg-1', 'overlap'],
		run: async (signal: AbortSignal) => {
			events.push('run-start')
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					'abort',
					() => {
						events.push('aborted')
						resolve()
					},
					{ once: true },
				)
			})
			// Stay in flight after abort until the test releases us. The helper
			// must dispatch without awaiting this completion.
			await new Promise<void>((resolve) => {
				releaseInline = resolve
			})
			events.push('run-end')
			return { status: 'published' }
		},
	})

	expect(outcome.kind).toBe('dispatched')
	expect(events).toEqual(['run-start', 'aborted', 'dispatched'])
	releaseInline?.()
})
