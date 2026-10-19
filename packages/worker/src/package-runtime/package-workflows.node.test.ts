import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { expect, test, vi } from 'vitest'
import { sessionRequestLineage } from '#worker/test-support/request-context.ts'
import type * as PackageInvocationsService from '#worker/package-invocations/service.ts'
import type * as RunKodyRegistry from '#mcp/run-kody-registry.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import {
	AccountSuspendedError,
	accountSuspendedMessage,
} from '#worker/account/account-suspension.ts'
import { type PackageInvocationStoredResponse } from '#worker/package-invocations/repo.ts'
import { type WorkflowProjectionUpsertInput } from '#worker/run-records/service.ts'
import { UserCodeError, isUserCodeError } from '#worker/user-code-error.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import {
	DynamicCallableWorkflowBase,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	type DynamicCallableWorkflowPayload,
} from './package-workflows.ts'
import {
	packageWorkflowsInvocationMocks as invocationMocks,
	packageWorkflowsRunRecordMocks as runRecordMocks,
	createWorkflowBinding,
	createStatefulWorkflowBinding,
	createWorkflowRunsDatabase,
} from '#worker/test-support/package-workflows.ts'

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

const backgroundUserMocks = vi.hoisted(() => ({
	resolveBackgroundMcpUser: vi.fn(async (_db: D1Database, userId: string) => ({
		userId,
		email: `${userId}@example.com`,
		username: userId,
		displayName: userId,
	})),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: (db: D1Database, userId: string) =>
		backgroundUserMocks.resolveBackgroundMcpUser(db, userId),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	beginRunRecord: (
		...args: Parameters<typeof RunRecordsServiceModule.beginRunRecord>
	) => runRecordMocks.beginRunRecord(...args),
	finishRunRecord: (
		...args: Parameters<typeof RunRecordsServiceModule.finishRunRecord>
	) => runRecordMocks.finishRunRecord(...args),
	updateRunErrorTriage: vi.fn(async () => ({ ok: true as const, run: {} })),
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

type FinishArgs = { status: string; logs?: Array<string>; error: unknown }

const runAt = '2026-05-03T12:34:56.000Z'
const packageBody = { packageId: 'pkg-1', exportName: './workflow-run-event' }

function createWorkflowEnv(binding: { workflow: Workflow }) {
	return {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		APP_BASE_URL: 'https://app.example.com',
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
}

function createInlineStep(attempt = 1) {
	return {
		sleepUntil: vi.fn(),
		do: vi.fn(
			async (
				_name: string,
				_config: unknown,
				callback: (ctx?: { attempt: number }) => unknown,
			) => await callback({ attempt }),
		),
	} as unknown as WorkflowStep
}

/** Queues a run for `user-1` on a fresh stateful binding; `run()` executes its queued payload. */
async function queueWorkflow(
	body: Record<string, unknown>,
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	} | null = null,
) {
	const binding = createStatefulWorkflowBinding()
	const env = createWorkflowEnv(binding)
	const created = await createDynamicCallableWorkflow({
		env,
		userId: ownerIdFromStored('user-1'),
		lineage: sessionRequestLineage('user-1'),
		packageContext,
		body: body as never,
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	const step = createInlineStep()
	const run = (payload: unknown = queued.params, instanceId = created.id) =>
		new DynamicCallableWorkflowBase(
			{ waitUntil: vi.fn() } as unknown as ExecutionContext,
			env,
		).run(
			{
				payload: payload as DynamicCallableWorkflowPayload,
				timestamp: new Date(),
				instanceId,
				workflowName: 'dynamic-callable-workflow',
			},
			step,
		)
	return { env, binding, created, queued, run, step }
}

const findRun = (id: string) =>
	runRecordMocks.listForUser('user-1').find((row) => row.id === id)

test('createDynamicCallableWorkflow queues inline code without package context and records runs before status reads', async () => {
	runRecordMocks.resetProjections()
	const code =
		'export default async function main(p) { return { ok: true, p } }'
	const { binding, created } = await queueWorkflow({
		code,
		runAt,
		idempotencyKey: 'inline-key',
		params: { greeting: 'hello' },
	})

	expect(created).toMatchObject({
		ok: true,
		id: expect.stringMatching(/^dynwf-/),
		source_type: 'inline',
		workflow_name: 'inline-code',
		export_name: null,
		status: 'queued',
	})
	expect(binding.create).toHaveBeenCalledWith({
		id: created.id,
		params: expect.objectContaining({
			version: 3,
			sourceType: 'inline',
			userId: ownerIdFromStored('user-1'),
			packageContext: null,
			code,
			params: { greeting: 'hello' },
		}),
		retention: { successRetention: '30 days', errorRetention: '30 days' },
	})
	expect(runRecordMocks.listForUser('user-1')).toEqual([
		expect.objectContaining({
			id: created.id,
			bindingName: dynamicCallableWorkflowsBindingName,
			status: 'queued',
			idempotencyKey: 'inline-key',
		}),
	])

	runRecordMocks.resetProjections()
	await expect(
		createDynamicCallableWorkflow({
			env: createWorkflowEnv(
				createWorkflowBinding({
					existing: null,
					statusThrows: new Error('status unavailable'),
				}),
			),
			userId: ownerIdFromStored('user-1'),
			lineage: sessionRequestLineage('user-1'),
			packageContext: null,
			body: {
				code: 'export default async function main() { return { ok: true } }',
				runAt,
				idempotencyKey: 'status-failure-key',
			},
		}),
	).rejects.toThrow('status unavailable')
	expect(runRecordMocks.listForUser('user-1')).toEqual([
		expect.objectContaining({
			status: 'queued',
			idempotencyKey: 'status-failure-key',
			bindingName: dynamicCallableWorkflowsBindingName,
		}),
	])
})

test('DynamicCallableWorkflowBase executes queued inline code and records completion', async () => {
	runRecordMocks.resetProjections()
	vi.useFakeTimers()
	try {
		// Create and complete under ordered clocks so monotonic upsert accepts
		// the terminal projection (lagging timestamps must not regress status).
		vi.setSystemTime(new Date(runAt))
		const code =
			'export default async function main(p){ return { ok: true, p }; }'
		const { created, run, step } = await queueWorkflow({
			code,
			runAt,
			idempotencyKey: 'execute-smoke',
			params: { greeting: 'hello' },
		})
		invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
			result: { ok: true, p: { greeting: 'hello' } },
			logs: [],
		})
		vi.setSystemTime(new Date('2026-05-03T12:35:00.000Z'))
		await expect(run()).resolves.toEqual({
			ok: true,
			p: { greeting: 'hello' },
		})
		const backgroundCaller = expect.objectContaining({
			executionOrigin: 'background',
			user: expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
		})
		expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
			expect.objectContaining({ APP_BASE_URL: 'https://app.example.com' }),
			backgroundCaller,
			code,
			{ greeting: 'hello' },
			{
				packageContext: null,
				executorTimeoutMs: backgroundExecutorTimeoutMs,
				runSurface: 'workflow',
			},
		)
		// The step outlasts the 5-minute sandbox so the sandbox timeout and run
		// finish land before the engine would cut the step.
		expect(step.do).toHaveBeenCalledWith(
			'execute inline workflow code',
			expect.objectContaining({ timeout: '6 minutes' }),
			expect.any(Function),
		)
		expect(findRun(created.id)).toMatchObject({
			status: 'complete',
			completedAt: expect.any(String),
			bindingName: dynamicCallableWorkflowsBindingName,
		})
	} finally {
		vi.useRealTimers()
	}
})

test('inline workflow sandbox failures throw UserCodeError except Durable Object resets', async () => {
	for (const { error, logs, userCode } of [
		{ error: 'boom', logs: ['[error] boom'], userCode: true },
		{
			error: 'Durable Object reset because its code was updated.',
			logs: [],
			userCode: false,
		},
	]) {
		runRecordMocks.resetProjections()
		const { created, run } = await queueWorkflow({
			code: 'export default async function main(){ throw new Error("boom"); }',
			runAt,
			idempotencyKey: `inline-failure-${userCode}`,
		})
		invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
			result: undefined,
			error,
			logs,
		})
		const thrown = await run().catch((caught: unknown) => caught)
		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toBe(error)
		expect(thrown instanceof UserCodeError).toBe(userCode)
		expect(isUserCodeError(thrown)).toBe(userCode)
		expect(findRun(created.id)).toMatchObject({
			status: 'errored',
			lastError: error,
			bindingName: dynamicCallableWorkflowsBindingName,
		})
		expect(runRecordMocks.beginRunRecord).toHaveBeenLastCalledWith(
			expect.objectContaining({
				userId: ownerIdFromStored('user-1'),
				context: expect.objectContaining({
					surface: 'workflow',
					workflowId: created.id,
					storageId: null,
					metadata: expect.objectContaining({
						sourceType: 'inline',
						workflow_step_attempt: 1,
					}),
				}),
			}),
		)
		const beginContext = runRecordMocks.beginRunRecord.mock.calls.at(-1)?.[0]
			?.context as { packageId?: string } | undefined
		expect(beginContext?.packageId).toBeUndefined()
		const [finish] = runRecordMocks.finishRunRecord.mock
			.lastCall as unknown as [FinishArgs]
		expect(finish).toMatchObject({ status: 'error', logs })
		expect(finish.error).toBeInstanceOf(Error)
		expect(finish.error instanceof UserCodeError).toBe(userCode)
	}
})

test('package-created inline workflows retain package secret authorization context', async () => {
	runRecordMocks.resetProjections()
	const packageContext = {
		packageId: 'package-1',
		kodyId: 'example-package',
		sourceId: 'source-1',
	}
	const { queued, run } = await queueWorkflow(
		{
			code: 'export default async function main(){ return { ok: true }; }',
			idempotencyKey: 'package-inline-security-context',
		},
		packageContext,
	)
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})
	const legacyPayload = { ...(queued.params as Record<string, unknown>) }
	delete legacyPayload['packageContext']
	await expect(run(legacyPayload, 'legacy-inline-workflow')).rejects.toThrow(
		'packageContext must be an object or null',
	)

	await run()

	const storageContext = {
		sessionId: null,
		appId: 'package-1',
		packageId: 'package-1',
		storageId: null,
	}
	expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({ storageContext }),
		expect.any(String),
		undefined,
		{
			packageContext,
			executorTimeoutMs: backgroundExecutorTimeoutMs,
			runSurface: 'workflow',
		},
	)
})

test('package export failures mark the run errored and classify user-code vs infrastructure errors', async () => {
	const failure = (status: number, code: string | null, message: string) => ({
		status,
		body: { ok: false, error: code ? { code, message } : { message } },
	})
	const shadeToolMessage =
		'Shade workflow event failed: Tool "kody.mcp[\\"home\\"].bond_shade_set_position" not found'
	const cases: Array<
		[PackageInvocationStoredResponse, string, 'user' | 'infrastructure' | null]
	> = [
		[failure(500, null, shadeToolMessage), shadeToolMessage, null],
		[
			{ status: 302, body: { ok: false } },
			'Package workflow export failed with HTTP 302.',
			'infrastructure',
		],
		[
			failure(500, 'execution_failed', 'boom from user package'),
			'boom from user package',
			'user',
		],
		[
			failure(404, 'export_not_found', 'Export "./missing" was not found.'),
			'Export "./missing" was not found.',
			'user',
		],
		[
			failure(
				503,
				'artifact_preparation_failed',
				'Package artifact preparation failed before execution.',
			),
			'Package artifact preparation failed before execution.',
			'infrastructure',
		],
		[
			failure(500, 'invocation_failed', 'Durable Object storage blew up.'),
			'Durable Object storage blew up.',
			'infrastructure',
		],
		[
			failure(
				503,
				'durable_object_reset',
				'Durable Object reset because its code was updated.',
			),
			'Durable Object reset because its code was updated.',
			'infrastructure',
		],
	]
	for (const [response, message, kind] of cases) {
		runRecordMocks.resetProjections()
		const { created, run } = await queueWorkflow({
			...packageBody,
			runAt,
			idempotencyKey: `package-failure-${response.status}-${message}`,
			params: { key: 'west-sensitive-reopen' },
		})
		invocationMocks.invokePackageExport.mockResolvedValueOnce(response)

		const thrown = await run().catch((caught: unknown) => caught)
		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toBe(message)
		expect(findRun(created.id)).toMatchObject({
			status: 'errored',
			completedAt: expect.any(String),
			lastError: message,
		})
		expect(runRecordMocks.beginRunRecord).toHaveBeenLastCalledWith(
			expect.objectContaining({
				context: expect.objectContaining({
					surface: 'workflow',
					packageId: 'pkg-1',
					workflowId: created.id,
				}),
			}),
		)
		const [finish] = runRecordMocks.finishRunRecord.mock
			.lastCall as unknown as [FinishArgs]
		expect(finish.status).toBe('error')
		expect(finish.error).toBeInstanceOf(Error)
		if (kind) {
			expect(thrown instanceof UserCodeError).toBe(kind === 'user')
			expect(isUserCodeError(thrown)).toBe(kind === 'user')
			expect(finish.error instanceof UserCodeError).toBe(kind === 'user')
		}
	}
})

test('suspended owners fail inline and package workflow steps once without retries', async () => {
	const bodies = [
		{
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'suspended-inline',
		},
		{ ...packageBody, idempotencyKey: 'suspended-package' },
	]
	for (const body of bodies) {
		runRecordMocks.resetProjections()
		const { created, run } = await queueWorkflow({ ...body, runAt })
		invocationMocks.runModuleWithRegistry.mockReset()
		invocationMocks.invokePackageExport.mockReset()
		// The inline path resolves the owner itself; the package path gets the
		// structured 403 that module execution returns for a suspended owner.
		backgroundUserMocks.resolveBackgroundMcpUser.mockRejectedValueOnce(
			new AccountSuspendedError(),
		)
		invocationMocks.invokePackageExport.mockResolvedValueOnce({
			status: 403,
			body: {
				ok: false,
				error: { code: 'account_suspended', message: accountSuspendedMessage },
			},
		})

		await expect(run()).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof NonRetryableError &&
				error.name === 'AccountSuspendedError' &&
				error.message === accountSuspendedMessage,
		)
		expect(invocationMocks.runModuleWithRegistry).not.toHaveBeenCalled()
		expect(findRun(created.id)).toMatchObject({
			status: 'errored',
			lastError: accountSuspendedMessage,
		})
		backgroundUserMocks.resolveBackgroundMcpUser.mockReset()
	}
})

test('package and inline workflows each record exactly one workflow run with workflowId', async () => {
	runRecordMocks.resetProjections()
	const packageRun = await queueWorkflow({
		...packageBody,
		workflowName: 'shade-event',
		runAt,
		idempotencyKey: 'package-single-run-record',
		params: { key: 'north' },
	})
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { result: { ok: true, source: 'package' }, logs: ['[log] pkg'] },
	})
	await packageRun.run()
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			context: expect.objectContaining({
				surface: 'workflow',
				name: 'shade-event',
				packageId: 'pkg-1',
				workflowId: packageRun.created.id,
				metadata: expect.objectContaining({
					sourceType: 'package',
					exportName: './workflow-run-event',
					workflow_step_attempt: 1,
				}),
			}),
		}),
	)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'success',
			logs: ['[log] pkg'],
			result: { ok: true, source: 'package' },
		}),
	)
	expect(invocationMocks.invokePackageExport).toHaveBeenCalledWith(
		expect.objectContaining({
			request: expect.objectContaining({ source: 'package-workflow' }),
		}),
	)

	runRecordMocks.beginRunRecord.mockClear()
	runRecordMocks.finishRunRecord.mockClear()
	const inlineRun = await queueWorkflow({
		code: 'export default async function main(){ return { ok: true }; }',
		workflowName: 'inline-once',
		runAt,
		idempotencyKey: 'inline-single-run-record',
	})
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true, source: 'inline' },
		logs: ['[log] inline'],
	})
	await inlineRun.run()
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			context: expect.objectContaining({
				surface: 'workflow',
				name: 'inline-once',
				workflowId: inlineRun.created.id,
				metadata: expect.objectContaining({
					sourceType: 'inline',
					workflow_step_attempt: 1,
				}),
			}),
		}),
	)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'success',
			logs: ['[log] inline'],
			result: { ok: true, source: 'inline' },
		}),
	)
})

test('workflow steps inherit the request that started the workflow', async () => {
	runRecordMocks.resetProjections()
	const lineage = sessionRequestLineage('user-1')
	const packageRun = await queueWorkflow({
		...packageBody,
		runAt,
		idempotencyKey: 'package-lineage',
	})
	expect(packageRun.queued.params).toMatchObject({ lineage })
	invocationMocks.invokePackageExport.mockResolvedValue({
		status: 200,
		body: { result: { ok: true } },
	})
	await packageRun.run()
	expect(invocationMocks.invokePackageExport).toHaveBeenLastCalledWith(
		expect.objectContaining({
			token: expect.objectContaining({
				request: { kind: 'inherited', lineage },
			}),
		}),
	)

	const { lineage: _lineage, ...legacyPayload } = packageRun.queued
		.params as DynamicCallableWorkflowPayload
	await packageRun.run(legacyPayload)
	expect(invocationMocks.invokePackageExport).toHaveBeenLastCalledWith(
		expect.objectContaining({
			token: expect.objectContaining({
				request: {
					kind: 'platform-event',
					sourceId: 'internal:package-workflows',
				},
			}),
		}),
	)
	invocationMocks.invokePackageExport.mockReset()

	const inlineRun = await queueWorkflow({
		code: 'export default async function main(){ return { ok: true }; }',
		runAt,
		idempotencyKey: 'inline-lineage',
	})
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})
	await inlineRun.run()
	expect(invocationMocks.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			request: expect.objectContaining({
				actor: lineage.actor,
				attribution: lineage.attribution,
				credential: lineage.credential,
			}),
		}),
		expect.anything(),
		undefined,
		expect.anything(),
	)
})
