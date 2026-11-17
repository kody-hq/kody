export const packageCheckWorkflowName = 'packageCheck'

/**
 * Marks a durable `packageCheck` run. The workflow engine never executes
 * this text: it runs `runPackageCheckWorkflow`, one durable step per
 * phase, for a run with this name and code.
 */
export const durablePackageCheckWorkflowCode =
	'// Built-in durable packageCheck run. Phases run as native workflow steps.'
