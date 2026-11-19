import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestLineage } from '@kody-internal/shared/request-context.ts'
import {
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	findWorkflowRunByIdempotencyKey,
	type PackageWorkflowCreateResult,
} from '#worker/package-runtime/package-workflows.ts'
import {
	isDeadTerminalWorkflowStatus,
	terminalWorkflowStatusValues,
} from '#worker/package-runtime/workflow-statuses.ts'
import {
	findWorkflowProjectionByBindingIdempotencyKey,
	releaseWorkflowProjectionIdempotencyKey,
} from '#worker/run-records/service.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'

export type DurableEscalationHandle = {
	status: 'dispatched'
	workflow_id: string
	workflow_name: string
	idempotency_key: string
	run_status: string | null
	message: string
}

export type DurableDispatchOutcome =
	| { kind: 'dispatched'; handle: DurableEscalationHandle }
	/**
	 * Preserve the original thrown value (including EntitlementLimitError) so
	 * callers can rethrow without stripping the cause chain that toApiError
	 * needs for entitlement_limit. Do not stringify here.
	 */
	| { kind: 'failed'; error: unknown }

/**
 * Workflow projection statuses that mean a durable dispatch is already underway.
 * Defined as the complement of terminal statuses so the set stays aligned with
 * createDynamicCallableWorkflow: active Cloudflare statuses plus any
 * transitional RunLog projection status written before the instance is queued
 * (today that transitional value is `creating`). New pre-active statuses are
 * covered automatically; only terminal runs (complete/errored/terminated/
 * cancelled) allow another dispatch.
 */
export const alreadyDispatchedWorkflowStatusExclusion =
	terminalWorkflowStatusValues

const terminalDurableEscalationStatuses = new Set<string>(
	alreadyDispatchedWorkflowStatusExclusion,
)

/**
 * Compose a workflow projection idempotency key that is always scoped to the
 * same acting `userId` used for RunLog lookup/create. Callers pass
 * operation-specific parts only; they must not invent a key under a different
 * identity.
 */
export function buildCallerScopedIdempotencyKey(input: {
	userId: OwnerId
	parts: ReadonlyArray<string>
}) {
	const userId = input.userId.trim()
	if (!userId) {
		throw new Error('Durable escalation userId must not be empty.')
	}
	const parts = input.parts.map((part) => part.trim()).filter(Boolean)
	if (parts.length === 0) {
		throw new Error(
			'Durable escalation requires at least one idempotency part.',
		)
	}
	return [userId, ...parts].join(':')
}

function createDispatchedHandle(input: {
	workflow: PackageWorkflowCreateResult
	idempotencyKey: string
}): DurableEscalationHandle {
	return {
		status: 'dispatched',
		workflow_id: input.workflow.id,
		workflow_name: input.workflow.workflow_name,
		idempotency_key: input.idempotencyKey,
		run_status: input.workflow.status ?? null,
		message:
			'Work was dispatched to a durable workflow. Poll with packageRunResult({ workflow_id }) until the run is terminal; do not retry the same operation while the run is active.',
	}
}

export async function findAlreadyDispatchedWorkflowRunByIdempotencyKey(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: OwnerId
	idempotencyKey: string
}): Promise<{
	id: string
	workflowName: string
	idempotencyKey: string
	status: string | null
} | null> {
	const trimmedKey = input.idempotencyKey.trim()
	if (!trimmedKey) return null
	const env = input.env as Env

	// Non-creating RunLog idempotency reader (active/terminal replay).
	const existing = await findWorkflowRunByIdempotencyKey({
		env,
		userId: input.userId,
		idempotencyKey: trimmedKey,
		bindingName: dynamicCallableWorkflowsBindingName,
	})
	if (existing) {
		const status = existing.status ?? ''
		if (!terminalDurableEscalationStatuses.has(status)) {
			return {
				id: existing.id,
				workflowName: existing.workflowName,
				idempotencyKey: existing.idempotencyKey,
				status: existing.status,
			}
		}
	}

	// Creating placeholders are excluded from the non-creating idempotency
	// reader; use the exact binding+idempotency lookup that includes `creating`.
	const match = await findWorkflowProjectionByBindingIdempotencyKey({
		env,
		userId: input.userId,
		bindingName: dynamicCallableWorkflowsBindingName,
		idempotencyKey: trimmedKey,
	})
	if (!match) return null
	const status = match.status ?? ''
	// Exact lookup includes creating; terminal rows fall through to create()
	// single-flight / fail-closed handling.
	if (
		status !== creatingWorkflowProjectionStatus &&
		terminalDurableEscalationStatuses.has(status)
	) {
		return null
	}
	return {
		id: match.id,
		workflowName: match.workflowName,
		idempotencyKey: match.idempotencyKey,
		status: match.status,
	}
}

/**
 * Create the durable Cloudflare Workflow for one operation and return its
 * handle. This is the only way the operation runs: there is no inline attempt
 * in the calling request. Never throws.
 *
 * Idempotency is always caller-scoped: `idempotencyParts` are joined with the
 * same `userId` used for RunLog projection lookup/create, so keys cannot
 * silently disagree with projection ownership. An active run for the key is
 * returned instead of a second one. A dead terminal run (errored, terminated,
 * cancelled) releases the key so the same operation can run again; set
 * `rerunComplete` when a complete run must not be replayed either (its result
 * depends on server state that may have changed since).
 */
export async function dispatchDurableRun(input: {
	env: Pick<Env, 'APP_DB' | 'DYNAMIC_CALLABLE_WORKFLOWS' | 'RUN_LOG'>
	userId: OwnerId
	userEmail?: string | null
	/** The run that dispatches; the durable workflow inherits it. */
	lineage: RequestLineage
	/**
	 * Operation-specific key segments (not including userId). The helper
	 * prefixes `userId` so RunLog projection dedupe stays aligned with scope.
	 */
	idempotencyParts: ReadonlyArray<string>
	workflowName: string
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	/** Package commit the operation targets; recorded on the workflow run. */
	enqueuedCommit?: string | null
	durableCode: string
	durableParams?: Record<string, unknown>
	rerunComplete?: boolean
}): Promise<DurableDispatchOutcome> {
	let idempotencyKey: string
	try {
		idempotencyKey = buildCallerScopedIdempotencyKey({
			userId: input.userId,
			parts: input.idempotencyParts,
		})
	} catch (error) {
		return {
			kind: 'failed',
			error,
		}
	}

	try {
		const existing = await findAlreadyDispatchedWorkflowRunByIdempotencyKey({
			env: input.env as Env,
			userId: input.userId,
			idempotencyKey,
		})
		if (existing) {
			return {
				kind: 'dispatched',
				handle: {
					status: 'dispatched',
					workflow_id: existing.id,
					workflow_name: existing.workflowName,
					idempotency_key: existing.idempotencyKey,
					run_status: existing.status,
					message:
						'An active durable run already exists for this idempotency key. Poll with packageRunResult({ workflow_id }) until the run is terminal; do not create another run.',
				},
			}
		}

		const createBody = {
			workflowName: input.workflowName,
			idempotencyKey,
			code: input.durableCode,
			params: input.durableParams,
		}
		const mustRerun = (status: string | null | undefined) =>
			isDeadTerminalWorkflowStatus(status) ||
			(input.rerunComplete === true && status === 'complete')
		let workflow = await createDynamicCallableWorkflow({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			packageContext: input.packageContext ?? null,
			enqueuedCommit: input.enqueuedCommit ?? null,
			body: createBody,
			lineage: input.lineage,
		})
		if (mustRerun(workflow.status)) {
			// Terminal failure (for example Durable Object reset mid-run) must
			// not keep the semantic key. Release it and create once more so the
			// same operation can re-dispatch; running and complete still dedupe.
			await releaseWorkflowProjectionIdempotencyKey({
				env: input.env as Env,
				userId: input.userId,
				id: workflow.id,
			})
			workflow = await createDynamicCallableWorkflow({
				env: input.env,
				userId: input.userId,
				userEmail: input.userEmail,
				packageContext: input.packageContext ?? null,
				enqueuedCommit: input.enqueuedCommit ?? null,
				body: createBody,
				lineage: input.lineage,
			})
			if (mustRerun(workflow.status)) {
				return {
					kind: 'failed',
					error: new Error(
						`A previous durable run "${workflow.id}" for this operation ended with status "${workflow.status}" and could not be re-dispatched after releasing its idempotency key.`,
					),
				}
			}
		}
		return {
			kind: 'dispatched',
			handle: createDispatchedHandle({ workflow, idempotencyKey }),
		}
	} catch (error) {
		return {
			kind: 'failed',
			error,
		}
	}
}
