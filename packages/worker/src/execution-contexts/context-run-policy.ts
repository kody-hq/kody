import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

export const contextRunDeniedCode = 'context_run_denied'

/** True when the request (or the root of its lineage) is an execution context run. */
export function isExecutionContextRunRequest(
	request: RequestContext | null | undefined,
) {
	return request?.credential.kind === 'execution-context-run'
}

/**
 * The `contextRuns` tag gate. Lineage copies the root credential, so a
 * nested invoke, workflow step or package event started by a context run is
 * checked here too.
 */
export function assertContextRunAllowed(
	request: RequestContext | null | undefined,
	capabilityName: string,
	policy: 'allow' | 'deny',
) {
	if (policy === 'allow' || !isExecutionContextRunRequest(request)) return
	throw new McpCallerError(
		`${capabilityName} is not available to runs on an execution context. Run it in Kody cloud instead (${contextRunDeniedCode}).`,
	)
}
