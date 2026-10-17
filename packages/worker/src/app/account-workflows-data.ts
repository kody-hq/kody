import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	listWorkflowRunsForUser,
	type WorkflowRunInspection,
} from '#worker/package-runtime/package-workflows.ts'
import {
	activeWorkflowStatusValues,
	terminalWorkflowStatusValues,
	type WorkflowRunStatus,
} from '#worker/package-runtime/workflow-statuses.ts'
import { getWorkflowProjection } from '#worker/run-records/service.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountWorkflowSourceType = 'package' | 'inline'

export type AccountWorkflowRunStatus = WorkflowRunStatus

export type AccountWorkflowListItem = {
	id: string
	sourceType: AccountWorkflowSourceType
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	workflowName: string
	exportName: string | null
	idempotencyKey: string
	runAt: string
	planDate: string | null
	status: AccountWorkflowRunStatus | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	lastError: string | null
}

export type AccountWorkflowDetail = AccountWorkflowListItem

export type AccountWorkflowsLoaderData = {
	ok: true
	username: string
	workflows: Array<AccountWorkflowListItem>
	selectedWorkflow: AccountWorkflowDetail | null
	selectedWorkflowId: string | null
}

const accountWorkflowsBasePath = '/account/workflows'
const defaultListLimit = 100

const knownWorkflowStatuses = new Set<string>([
	...activeWorkflowStatusValues,
	...terminalWorkflowStatusValues,
])

const terminalWorkflowStatuses = new Set<string>(terminalWorkflowStatusValues)

export function isTerminalWorkflowStatus(
	status: AccountWorkflowRunStatus | null,
) {
	return status !== null && terminalWorkflowStatuses.has(status)
}

export function isActiveWorkflowStatus(
	status: AccountWorkflowRunStatus | null,
) {
	return !isTerminalWorkflowStatus(status)
}

export function readAccountWorkflowsSelectedWorkflowId(
	requestUrl: string,
	pathWorkflowId?: string,
) {
	if (pathWorkflowId?.trim()) return pathWorkflowId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountWorkflowsBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const workflowId = decodeURIComponent(segment)
				if (workflowId) return workflowId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

function toListItem(workflow: WorkflowRunInspection): AccountWorkflowListItem {
	return {
		id: workflow.id,
		sourceType: workflow.sourceType,
		packageId: workflow.packageId,
		kodyId: workflow.kodyId,
		sourceId: workflow.sourceId,
		workflowName: workflow.workflowName,
		exportName: workflow.exportName,
		idempotencyKey: workflow.idempotencyKey,
		runAt: workflow.runAt,
		planDate: workflow.planDate,
		status: workflow.status,
		createdAt: workflow.createdAt,
		updatedAt: workflow.updatedAt,
		completedAt: workflow.completedAt,
		lastError: workflow.lastError,
	}
}

function projectionStatus(
	rawStatus: string | null,
): AccountWorkflowRunStatus | null {
	if (rawStatus === creatingWorkflowProjectionStatus) return null
	if (typeof rawStatus === 'string' && knownWorkflowStatuses.has(rawStatus)) {
		return rawStatus as AccountWorkflowRunStatus
	}
	return null
}

export async function loadAccountWorkflowsData(input: {
	env: Env
	user: AuthenticatedUser
	selectedWorkflowId: string | null
}): Promise<AccountWorkflowsLoaderData> {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const selectedWorkflowId = input.selectedWorkflowId

	const workflows = (
		await listWorkflowRunsForUser({
			env: input.env,
			userId,
			limit: defaultListLimit,
		})
	).map(toListItem)

	let selectedWorkflow =
		workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null

	if (selectedWorkflowId && !selectedWorkflow) {
		const projection = await getWorkflowProjection({
			env: input.env,
			userId,
			id: selectedWorkflowId,
		})
		if (projection) {
			selectedWorkflow = {
				id: projection.id,
				sourceType: projection.sourceType,
				packageId: projection.packageId,
				kodyId: projection.kodyId,
				sourceId: projection.sourceId,
				workflowName: projection.workflowName,
				exportName: projection.exportName,
				idempotencyKey: projection.idempotencyKey,
				runAt: projection.runAt,
				planDate: projection.planDate,
				status: projectionStatus(projection.status),
				createdAt: projection.createdAt,
				updatedAt: projection.updatedAt,
				completedAt: projection.completedAt,
				lastError: projection.lastError,
			}
		}
	}

	return {
		ok: true,
		username: input.user.username,
		workflows,
		selectedWorkflow,
		selectedWorkflowId,
	}
}
