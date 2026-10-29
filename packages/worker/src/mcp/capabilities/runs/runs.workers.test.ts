import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { runGetCapability } from './run-get.ts'
import { runListCapability } from './run-list.ts'
import { runSummaryCapability } from './run-summary.ts'
import { runUpdateBulkCapability } from './run-update-bulk.ts'
import { runUpdateCapability } from './run-update.ts'

// The first Durable Object class load in a workers-unit file costs ~10s in the
// vitest pool (warm RPCs are ~1ms; production finish is ~0.4ms). These tests
// also issue many RunLog RPCs, so budget well above the shared 20s default
// (decision 0011 — do not try to warm DOs from setupFiles).
const runLogSuiteTimeoutMs = 60_000

// Every test mints a fresh user id, so its RunLog Durable Object starts empty
// and needs no clearing.
function createTenant(label: string) {
	const userId = `runs-cap-${label}-${crypto.randomUUID()}`
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(userId),
				email: `${userId}@example.com`,
				displayName: 'Runs Tester',
			},
		}),
	}
	const baseMs = Date.now() - 60_000
	return {
		userId,
		ctx,
		list: (input: Parameters<typeof runListCapability.handler>[0] = {}) =>
			runListCapability.handler(input, ctx),
		get: (runId: string) => runGetCapability.handler({ run_id: runId }, ctx),
		summary: () => runSummaryCapability.handler({}, ctx),
		update: (input: Parameters<typeof runUpdateCapability.handler>[0]) =>
			runUpdateCapability.handler(input, ctx),
		updateBulk: (
			input: Parameters<typeof runUpdateBulkCapability.handler>[0],
		) => runUpdateBulkCapability.handler(input, ctx),
		async finishRun(input: {
			id: string
			offsetMs: number
			context: Partial<RunRecordContext>
			error?: string
			logs?: Array<string>
			result?: unknown
		}) {
			const handle: RunRecordHandle = {
				id: input.id,
				userId: ownerIdFromStored(userId),
				startedAt: new Date(baseMs + input.offsetMs).toISOString(),
				persistence: 'eager',
				context: { surface: 'job', name: 'example-job', ...input.context },
			}
			await finishRunRecord({
				env,
				handle,
				status: input.error ? 'error' : 'success',
				logs: input.logs,
				error: input.error ? new Error(input.error) : undefined,
				result: input.result,
			})
			return handle
		},
	}
}

test(
	'run capabilities smoke: authentication, list, get, summary, and tenant isolation',
	async () => {
		const anonymous = {
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
			}),
		}
		const authRequired = /Authenticated MCP user/
		await expect(runListCapability.handler({}, anonymous)).rejects.toThrow(
			authRequired,
		)
		await expect(
			runGetCapability.handler({ run_id: 'missing' }, anonymous),
		).rejects.toThrow(authRequired)
		await expect(runSummaryCapability.handler({}, anonymous)).rejects.toThrow(
			authRequired,
		)
		await expect(
			runUpdateCapability.handler(
				{ run_id: 'missing', triage: 'ignored' },
				anonymous,
			),
		).rejects.toThrow(authRequired)
		await expect(
			runUpdateBulkCapability.handler(
				{ run_ids: ['missing'], triage: 'ignored' },
				anonymous,
			),
		).rejects.toThrow(authRequired)

		const owner = createTenant('tenant')
		const other = createTenant('other')
		const handle = await owner.finishRun({
			id: 'run-job-err',
			offsetMs: 0,
			context: { jobId: 'job-a', name: 'with-logs' },
			error: 'boom',
			logs: ['line-one', 'line-two'],
		})
		await owner.finishRun({
			id: 'run-webhook',
			offsetMs: 1000,
			context: {
				surface: 'webhook',
				name: 'sentry',
				metadata: {
					endpointId: 'ep-result',
					httpStatus: 202,
					outcome: 'delivered',
				},
			},
			result: { ok: true, agentId: 'agent-123' },
		})
		const pending: Array<Promise<unknown>> = []
		beginRunRecord({
			env,
			userId: ownerIdFromStored(owner.userId),
			context: {
				surface: 'workflow',
				workflowId: 'wf-running',
				name: 'still-going',
			},
			waitUntil: (promise) => {
				pending.push(promise)
			},
		})
		await Promise.all(pending)

		const jobRuns = await owner.list({ surface: 'job' })
		expect(jobRuns.runs.some((r) => r.id === 'run-job-err')).toBe(true)
		expect((await other.list()).runs).toEqual([])

		const detail = await owner.get(handle.id)
		expect(detail.run.status).toBe('error')
		expect(detail.logs).toHaveLength(2)
		expect((await owner.get('run-webhook')).run.metadata).toMatchObject({
			endpointId: 'ep-result',
			outcome: 'delivered',
			result: { ok: true, agentId: 'agent-123' },
		})
		// A miss falls through to execution context history; this database has
		// no execution_contexts table, so that lookup warns and returns nothing.
		consoleWarn.mockImplementation(() => {})
		await expect(other.get(handle.id)).rejects.toThrow(/was not found/)
		await expect(owner.get(crypto.randomUUID())).rejects.toThrow(
			/was not found/,
		)
		expect(consoleWarn).toHaveBeenCalledWith(
			'execution-context-run-lookup-failed',
			expect.anything(),
		)

		// Owner totals include the in-flight workflow run; other tenant sees zeros.
		const summary = await owner.summary()
		expect(summary.total).toBeGreaterThanOrEqual(3)
		expect(summary.errors).toBeGreaterThanOrEqual(1)
		expect(summary.running).toBeGreaterThanOrEqual(1)
		expect(
			summary.by_surface.some(
				(entry) => entry.surface === 'job' && entry.total >= 1,
			),
		).toBe(true)
		expect(await other.summary()).toMatchObject({
			total: 0,
			errors: 0,
			ignored: 0,
			resolved: 0,
		})
	},
	runLogSuiteTimeoutMs,
)

test(
	'runUpdateBulk previews and exactly scopes bounded non-destructive triage',
	async () => {
		const owner = createTenant('bulk-triage')
		const cases = [
			['job-a-duplicate-1', 'job-a', 'free plan limit reached'],
			['job-a-duplicate-2', 'job-a', 'free plan limit reached'],
			['job-b-same-message', 'job-b', 'free plan limit reached'],
			['job-a-other-error', 'job-a', 'different failure'],
		] as const
		for (const [index, [id, jobId, error]] of cases.entries()) {
			await owner.finishRun({
				id,
				offsetMs: index,
				context: { jobId, name: 'recurring-job' },
				error,
			})
		}
		await owner.finishRun({
			id: 'successful-run',
			offsetMs: 10,
			context: { surface: 'webhook', name: 'successful-webhook' },
		})
		const bulkInput = {
			filter: { job_id: 'job-a', error_message: 'free plan limit reached' },
			triage: 'resolved' as const,
			note: 'entitlements fix deployed',
			limit: 1,
		}

		const preview = await owner.updateBulk({ ...bulkInput, dry_run: true })
		expect(preview).toMatchObject({
			updated_count: 0,
			has_more: true,
			dry_run: true,
		})
		expect(preview.matched_run_ids).toHaveLength(1)
		await expect(owner.updateBulk(bulkInput)).resolves.toMatchObject({
			updated_count: 1,
			has_more: true,
		})
		await expect(owner.updateBulk(bulkInput)).resolves.toMatchObject({
			updated_count: 1,
			has_more: false,
		})

		const allErrors = await owner.list({
			status: 'error',
			error_triage: 'all',
			limit: 10,
		})
		const byId = new Map(allErrors.runs.map((run) => [run.id, run]))
		for (const id of ['job-a-duplicate-1', 'job-a-duplicate-2']) {
			expect(byId.get(id)).toMatchObject({
				status: 'error',
				error_message: 'free plan limit reached',
				error_triage: 'resolved',
				triage_note: 'entitlements fix deployed',
				triaged_by: owner.userId,
			})
		}
		expect(byId.get('job-b-same-message')?.error_triage).toBeNull()
		expect(byId.get('job-a-other-error')?.error_triage).toBeNull()

		await expect(
			owner.updateBulk({
				run_ids: ['job-b-same-message', 'successful-run'],
				triage: 'ignored',
				note: 'known duplicate',
			}),
		).resolves.toMatchObject({
			matched_run_ids: ['job-b-same-message'],
			updated_count: 1,
			has_more: false,
		})
		expect((await owner.get('successful-run')).run).toMatchObject({
			status: 'success',
			error_triage: null,
		})
		expect(await owner.summary()).toMatchObject({
			total: 5,
			errors: 1,
			ignored: 1,
			resolved: 2,
		})

		// Reopening explicit ids updates only triaged rows; an already-open
		// error is not counted as a match or update.
		await expect(
			owner.updateBulk({
				run_ids: ['job-b-same-message', 'job-a-other-error'],
				triage: 'open',
			}),
		).resolves.toMatchObject({
			matched_run_ids: ['job-b-same-message'],
			updated_count: 1,
			has_more: false,
		})
		expect(await owner.summary()).toMatchObject({
			total: 5,
			errors: 2,
			ignored: 0,
			resolved: 2,
		})
	},
	runLogSuiteTimeoutMs,
)

test(
	'runUpdate triage: set/list/filter/summary/reopen and preserve error details',
	async () => {
		const owner = createTenant('triage')
		const noise = {
			id: 'err-noise',
			offsetMs: 1000,
			context: { name: 'soft-fail' },
			error: 'expected flake',
		}
		await owner.finishRun({
			id: 'err-open',
			offsetMs: 0,
			context: { name: 'keep-open' },
			error: 'still broken',
		})
		await owner.finishRun(noise)
		await owner.finishRun({
			id: 'ok-run',
			offsetMs: 2000,
			context: { name: 'ok' },
		})

		const ignored = await owner.update({
			run_id: 'err-noise',
			triage: 'ignored',
			note: 'known flake',
		})
		expect(ignored.run).toMatchObject({
			id: 'err-noise',
			status: 'error',
			error_message: 'expected flake',
			error_triage: 'ignored',
			triage_note: 'known flake',
			triaged_by: owner.userId,
		})
		expect(ignored.run.triaged_at).toBeTruthy()

		// A later finish must preserve soft triage (INSERT OR REPLACE used to wipe it).
		await owner.finishRun(noise)
		expect((await owner.get('err-noise')).run).toMatchObject({
			error_triage: 'ignored',
			triage_note: 'known flake',
			triaged_by: owner.userId,
			error_message: 'expected flake',
		})
		await expect(
			owner.update({ run_id: 'ok-run', triage: 'resolved' }),
		).rejects.toThrow(/only error runs/)

		const ids = async (input: Parameters<typeof owner.list>[0]) =>
			(await owner.list(input)).runs.map((run) => run.id).sort()
		expect(await ids({ status: 'error' })).toEqual(['err-open'])
		expect(await ids({ error_triage: 'ignored' })).toEqual(['err-noise'])
		expect(await ids({ error_triage: 'all', status: 'error' })).toEqual([
			'err-noise',
			'err-open',
		])

		const resolved = await owner.update({
			run_id: 'err-noise',
			triage: 'resolved',
			note: 'fixed upstream',
		})
		expect(resolved.run).toMatchObject({
			error_triage: 'resolved',
			triage_note: 'fixed upstream',
			error_message: 'expected flake',
		})
		// Omitting note must preserve the existing triage note across the DO RPC.
		await expect(
			owner.update({ run_id: 'err-noise', triage: 'ignored' }),
		).resolves.toMatchObject({
			run: { error_triage: 'ignored', triage_note: 'fixed upstream' },
		})
		expect(await owner.summary()).toMatchObject({
			errors: 1,
			ignored: 1,
			resolved: 0,
		})

		await expect(
			owner.update({ run_id: 'err-noise', triage: 'open' }),
		).resolves.toMatchObject({
			run: {
				error_triage: null,
				triage_note: null,
				triaged_at: null,
				triaged_by: null,
				error_message: 'expected flake',
			},
		})
		expect(await owner.summary()).toMatchObject({
			errors: 2,
			ignored: 0,
			resolved: 0,
		})
		expect((await owner.get('err-noise')).run).toMatchObject({
			error_triage: null,
			error_message: 'expected flake',
		})
	},
	runLogSuiteTimeoutMs,
)

test(
	'runList and runGet surface execute entry and workerId metadata',
	async () => {
		const owner = createTenant('execute-attribution')
		await owner.finishRun({
			id: 'run-execute-attr',
			offsetMs: 0,
			context: {
				surface: 'execute',
				name: null,
				metadata: {
					conversationId: 'conv-attr',
					entry: 'invoke',
					invoke: 'kody:@acme/github/listRepos',
					workerId: 'kody-abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
					sandboxMs: 12,
				},
			},
			result: { ok: true },
		})
		await owner.finishRun({
			id: 'run-package-job',
			offsetMs: 1,
			context: {
				surface: 'job',
				name: 'digest',
				packageId: 'pkg-1',
				publishedCommit: 'abc123',
				jobId: 'job-1',
			},
		})

		const listed = await owner.list({
			surface: 'execute',
			error_triage: 'all',
		})
		expect(listed.runs).toEqual([
			expect.objectContaining({
				id: 'run-execute-attr',
				surface: 'execute',
				package_id: null,
				published_commit: null,
				metadata: expect.objectContaining({
					entry: 'invoke',
					invoke: 'kody:@acme/github/listRepos',
					workerId: 'kody-abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
					result: { ok: true },
				}),
			}),
		])

		const detail = await owner.get('run-execute-attr')
		expect(detail.run.metadata).toMatchObject({
			entry: 'invoke',
			workerId: 'kody-abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
		})

		const packageJob = await owner.get('run-package-job')
		expect(packageJob.run).toMatchObject({
			package_id: 'pkg-1',
			published_commit: 'abc123',
			job_id: 'job-1',
		})
		expect(packageJob.run.metadata).not.toHaveProperty('entry')
		expect(packageJob.run.metadata).not.toHaveProperty('workerId')
	},
	runLogSuiteTimeoutMs,
)
