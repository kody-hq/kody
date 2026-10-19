import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestLineage } from '@kody-internal/shared/request-context.ts'
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

/**
 * Soft budget under Cursor/client ~60s tools/call and MCP execute's ~90s
 * sandbox, leaving room to return a dispatched handle before the client gives
 * up. Progress notifications do not reset the client timeout.
 */
export const defaultDurableEscalationBudgetMs = 35_000

export type DurableEscalationHandle = {
	status: 'dispatched'
	workflow_id: string
	workflow_name: string
	idempotency_key: string
	run_status: string | null
	message: string
}

export type DurableEscalationOutcome<T> =
	| { kind: 'completed'; value: T }
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
 * cancelled) allow another inline attempt.
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
			'Work exceeded the inline budget and was dispatched to a durable workflow. Poll workflowRunList with this workflow_id; do not retry the same operation while the run is active.',
	}
}

async function findAlreadyDispatchedWorkflowRunByIdempotencyKey(input: {
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

function waitForAbort(signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve()
			return
		}
		signal.addEventListener('abort', () => resolve(), { once: true })
	})
}

type SettledInlineRun<T> =
	| { kind: 'completed'; value: T }
	| { kind: 'rejected'; error: unknown }

/**
 * Attempt `run` within a wall-clock budget. On budget exhaustion, create a
 * durable Cloudflare Workflow for the same work and return a handle instead of
 * hanging past MCP execute's timeout. Never throws.
 *
 * Idempotency is always caller-scoped: `idempotencyParts` are joined with the
 * same `userId` used for RunLog projection lookup/create, so keys cannot
 * silently disagree with projection ownership.
 */
export async function runWithDurableEscalation<T>(input: {
	env: Pick<Env, 'APP_DB' | 'DYNAMIC_CALLABLE_WORKFLOWS' | 'RUN_LOG'>
	userId: OwnerId
	userEmail?: string | null
	/** The run that escalates; the durable workflow inherits it. */
	lineage: RequestLineage
	budgetMs?: number
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
	durableCode: string
	durableParams?: Record<string, unknown>
	run: (signal: AbortSignal) => Promise<T>
}): Promise<DurableEscalationOutcome<T>> {
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
						'An active durable run already exists for this idempotency key. Poll workflowRunList with this workflow_id; do not create another run.',
				},
			}
		}

		const budgetMs = Math.max(
			1,
			input.budgetMs ?? defaultDurableEscalationBudgetMs,
		)
		const controller = new AbortController()
		const timer = setTimeout(() => {
			controller.abort()
		}, budgetMs)

		const settledRef: { current: SettledInlineRun<T> | null } = {
			current: null,
		}
		const runPromise = input.run(controller.signal).then(
			(value) => {
				settledRef.current = { kind: 'completed', value }
				return value
			},
			(error: unknown) => {
				settledRef.current = { kind: 'rejected', error }
				throw error
			},
		)
		// The inline attempt is not cancelled on budget expiry (and must not be:
		// aborting mid-publish could leave partial state). Keep the rejection
		// handled so an abandoned-in-flight attempt cannot surface unhandled.
		void runPromise.catch(() => {})

		try {
			const raced = await Promise.race([
				runPromise.then(
					(value) => ({ kind: 'completed' as const, value }),
					(error: unknown) => ({ kind: 'rejected' as const, error }),
				),
				waitForAbort(controller.signal).then(() => ({
					kind: 'aborted' as const,
				})),
			])

			if (raced.kind === 'completed') {
				return { kind: 'completed', value: raced.value }
			}
			if (raced.kind === 'rejected') {
				if (controller.signal.aborted) {
					// Fall through: prefer any same-tick settlement below, else dispatch.
				} else {
					return {
						kind: 'failed',
						error: raced.error,
					}
				}
			}

			// Drain microtasks so a run that finished in the same turn as the
			// abort is observed before we create a redundant workflow.
			await Promise.resolve()
			const settled = settledRef.current
			if (settled?.kind === 'completed') {
				return { kind: 'completed', value: settled.value }
			}
			if (settled?.kind === 'rejected' && !controller.signal.aborted) {
				return {
					kind: 'failed',
					error: settled.error,
				}
			}
			// Inline work may still be running. We dispatch anyway rather than
			// awaiting it (awaiting would reintroduce the opaque MCP timeout).
			// Overlap is intentional and safe for publish: we do not cancel the
			// in-flight attempt (partial apply is worse than duplication), the
			// durable re-entry is idempotent on matching published_commit at the
			// RepoSession layer, callers pass a pre-request tip baseline so a
			// tip advance still reports published (not already_published), and
			// RepoSession DO RPCs serialize per session id so the common
			// first-attempt session cannot interleave mutations.
		} finally {
			clearTimeout(timer)
		}

		const createBody = {
			workflowName: input.workflowName,
			idempotencyKey,
			code: input.durableCode,
			params: input.durableParams,
		}
		let workflow = await createDynamicCallableWorkflow({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			packageContext: input.packageContext ?? null,
			body: createBody,
			lineage: input.lineage,
		})
		if (isDeadTerminalWorkflowStatus(workflow.status)) {
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
				body: createBody,
				lineage: input.lineage,
			})
			if (isDeadTerminalWorkflowStatus(workflow.status)) {
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
