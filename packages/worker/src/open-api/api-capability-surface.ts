import { apiOperationsById } from './operations.ts'

/**
 * Capability domains that are never published on the Open API or MCP `api`
 * tool. Search still lists these capabilities for `execute`.
 */
export const openApiExcludedDomains = new Set(['admin', 'apps', 'coding'])

/**
 * Named capabilities deliberately omitted from the Open API even when their
 * domain is otherwise published. Search still lists them for `execute`.
 */
export const openApiExcludedCapabilities = new Set([
	'execute',
	'metaListCapabilities',
	'packageSubscriptionDispatch',
	'webhookSyntheticDispatch',
	'communitySetFeatured',
	'orgDelete',
	'orgRestore',
	'resourceRestore',
])

/**
 * True when MCP `api` / HTTPS Open API accepts this name as `operationId`.
 * Search hits that return false are execute-only.
 */
export function isCapabilityAvailableViaApiTool(capabilityName: string) {
	// Native routes may reuse a capability name (hosted `execute`) without
	// publishing that capability on the `api` tool.
	return apiOperationsById.get(capabilityName)?.kind === 'capability'
}

export function capabilityApiAvailabilitySummary(capabilityName: string) {
	if (isCapabilityAvailableViaApiTool(capabilityName)) {
		return {
			apiAvailable: true as const,
			summary: `Open API / MCP \`api\`: available as operationId \`${capabilityName}\``,
		}
	}
	return {
		apiAvailable: false as const,
		summary:
			'Open API / MCP `api`: not available (execute-only). Call this capability from `execute`, not `api`.',
	}
}
