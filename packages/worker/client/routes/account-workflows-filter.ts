import { matchesSearchQuery } from '#client/search-filter.ts'

export type AccountWorkflowsViewFilter = 'active' | 'history' | 'all'

export type FilterableAccountWorkflow = {
	id: string
	sourceType: string
	packageId?: string | null
	workflowName: string
	exportName?: string | null
	status: string | null
	runAt: string
	lastError?: string | null
	idempotencyKey?: string | null
}

/** Terminal Cloudflare Workflow statuses (client-safe copy of server constants). */
const terminalStatuses = new Set([
	'complete',
	'errored',
	'terminated',
	'cancelled',
])

/**
 * Non-terminal runs (queued, waiting, running, paused, …) plus null status
 * while a projection is still being created.
 */
export function isActiveAccountWorkflow(
	workflow: Pick<FilterableAccountWorkflow, 'status'>,
) {
	if (workflow.status === null) return true
	return !terminalStatuses.has(workflow.status)
}

export function filterAccountWorkflows<
	Workflow extends FilterableAccountWorkflow,
>(
	workflows: ReadonlyArray<Workflow>,
	input: {
		view: AccountWorkflowsViewFilter
		search: string
	},
): Array<Workflow> {
	return workflows.filter((workflow) => {
		if (input.view !== 'all') {
			const active = isActiveAccountWorkflow(workflow)
			if (input.view === 'active' ? !active : active) return false
		}
		return matchesSearchQuery(input.search, [
			workflow.workflowName,
			workflow.id,
			workflow.sourceType,
			workflow.packageId ?? '',
			workflow.exportName ?? '',
			workflow.status,
			workflow.runAt,
			workflow.lastError,
			workflow.idempotencyKey,
		])
	})
}
