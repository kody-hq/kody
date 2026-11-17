/**
 * Durable package runs. `packageCheck` and `packagePublishExternalPush` both
 * answer with a dispatched workflow handle; this follows that run to its end,
 * prints its progress, and reads the stored result.
 */
import {
	callOpenApiOperation,
	openApiRequest,
	type OpenApiClientInput,
} from './open-api-client.js'
import type { PackageCheckFiles } from './package-check-files.js'

const terminalRunStatuses = new Set([
	'complete',
	'errored',
	'terminated',
	'cancelled',
])

export type PackageRunProgress = {
	phase: string
	message: string
	done?: number
	total?: number
}

type PackageRunClient = Pick<
	OpenApiClientInput,
	'token' | 'apiUrl' | 'fetchFn' | 'org' | 'onHttpDebug'
>

export type FollowPackageRunInput = PackageRunClient & {
	workflowId: string
	/** Called when the run reports a phase or chunk count it has not yet. */
	onProgress?: (progress: PackageRunProgress) => void
	/** Aborting cancels the run on the server, then rejects. */
	signal?: AbortSignal
	pollMs?: number
}

export class PackageRunCancelledError extends Error {
	constructor(workflowId: string) {
		super(`Cancelled run ${workflowId}.`)
		this.name = 'PackageRunCancelledError'
	}
}

/** The run ended without a result: Kody failed, or the publish was refused. */
export class PackageRunFailedError extends Error {
	readonly workflowId: string
	readonly runStatus: string

	constructor(input: { workflowId: string; status: string; reason: string }) {
		super(input.reason)
		this.name = 'PackageRunFailedError'
		this.workflowId = input.workflowId
		this.runStatus = input.status
	}
}

function asRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function readProgress(value: unknown): PackageRunProgress | null {
	const record = asRecord(value)
	if (
		!record ||
		typeof record.phase !== 'string' ||
		typeof record.message !== 'string'
	) {
		return null
	}
	return {
		phase: record.phase,
		message: record.message,
		...(typeof record.done === 'number' ? { done: record.done } : {}),
		...(typeof record.total === 'number' ? { total: record.total } : {}),
	}
}

/** `workflow_id` from a dispatched answer, or null when it is not one. */
export function readDispatchedWorkflowId(value: unknown) {
	const record = asRecord(value)
	return record?.status === 'dispatched' &&
		typeof record.workflow_id === 'string' &&
		record.workflow_id
		? record.workflow_id
		: null
}

async function sleep(ms: number, signal: AbortSignal | undefined) {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms)
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		signal?.addEventListener('abort', done, { once: true })
	})
}

/**
 * Poll `workflowRunList` until the run is terminal, then return its stored
 * result (`packageRunResult`). Rejects with {@link PackageRunFailedError}
 * when the run ended without one.
 */
export async function followPackageRun(
	input: FollowPackageRunInput,
): Promise<Record<string, unknown>> {
	const { workflowId, onProgress, signal, pollMs, ...client } = input
	let lastProgress = ''
	for (;;) {
		if (signal?.aborted) {
			await callOpenApiOperation({
				...client,
				operationId: 'workflowRunCancel',
				params: { id: workflowId },
			}).catch(() => {})
			throw new PackageRunCancelledError(workflowId)
		}
		const page = asRecord(
			await callOpenApiOperation({
				...client,
				operationId: 'workflowRunList',
				params: { workflow_id: workflowId, limit: 1 },
			}),
		)
		const run = asRecord(
			Array.isArray(page?.workflows) ? page.workflows[0] : null,
		)
		const progress = readProgress(run?.progress)
		if (progress) {
			const key = JSON.stringify(progress)
			if (key !== lastProgress) {
				lastProgress = key
				onProgress?.(progress)
			}
		}
		const status = typeof run?.status === 'string' ? run.status : null
		if (status && terminalRunStatuses.has(status)) {
			// A publish that was refused ends its run errored and still stores
			// the full refusal; a run Kody itself failed stores nothing.
			const stored = asRecord(
				await callOpenApiOperation({
					...client,
					operationId: 'packageRunResult',
					params: { workflow_id: workflowId },
				}),
			)
			const result = asRecord(stored?.result)
			if (result) return result
			throw new PackageRunFailedError({
				workflowId,
				status,
				reason:
					status === 'complete'
						? `Run ${workflowId} completed, but its result is no longer stored.`
						: typeof run?.last_error === 'string' && run.last_error
							? run.last_error
							: `Run ${workflowId} ended ${status}.`,
			})
		}
		await sleep(pollMs ?? 1_500, signal)
	}
}

/** Upload the tree, start the durable check, and follow it to its result. */
export async function runDurablePackageCheck(
	input: PackageRunClient & {
		tree: PackageCheckFiles
		onProgress?: (progress: PackageRunProgress) => void
		signal?: AbortSignal
		pollMs?: number
	},
): Promise<Record<string, unknown>> {
	const { tree, onProgress, signal, pollMs, ...client } = input
	const upload = asRecord(
		await openApiRequest({
			...client,
			method: 'POST',
			path: '/v1/packages/check-uploads',
			body: { files: tree.files, binary_contents: tree.binaryContents },
		}),
	)
	if (typeof upload?.upload_id !== 'string') {
		throw new Error('The package tree upload returned no upload_id.')
	}
	const workflowId = readDispatchedWorkflowId(
		await callOpenApiOperation({
			...client,
			operationId: 'packageCheck',
			params: { upload_id: upload.upload_id },
		}),
	)
	if (!workflowId) {
		throw new Error('packageCheck returned an unexpected response.')
	}
	return await followPackageRun({
		...client,
		workflowId,
		...(onProgress ? { onProgress } : {}),
		...(signal ? { signal } : {}),
		...(pollMs !== undefined ? { pollMs } : {}),
	})
}

/** An AbortSignal that fires on the first Ctrl-C (or SIGTERM), and its cleanup. */
export function abortOnInterrupt() {
	const controller = new AbortController()
	const abort = () => controller.abort()
	process.once('SIGINT', abort)
	process.once('SIGTERM', abort)
	return {
		signal: controller.signal,
		dispose() {
			process.off('SIGINT', abort)
			process.off('SIGTERM', abort)
		},
	}
}

export function formatPackageRunProgress(progress: PackageRunProgress) {
	return progress.message
}
