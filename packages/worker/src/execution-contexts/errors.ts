import { McpCallerError } from '#mcp/caller-error.ts'

export const executionContextErrorCodes = [
	'feature_disabled',
	'invalid_request',
	'not_found',
	'not_granted',
	'context_revoked',
	'chain_changed',
	'chain_too_long',
	'context_not_usable',
	'no_execution_context_available',
	'execution_context_unavailable',
	'insufficient_scope',
	'execution_context_lease_invalid',
	'execution_context_access_lost',
	'context_not_revoked',
	'commands_opt_in_local',
	'execution_context_commands_off',
	'execution_context_command_not_granted',
	'execution_context_command_requires_context',
] as const

export type ExecutionContextErrorCode =
	(typeof executionContextErrorCodes)[number]

/**
 * A caller error with an HTTP status and a stable code, so MCP shows the
 * message while the Open API answers with the documented status and body.
 */
export class ExecutionContextError extends McpCallerError {
	readonly status: number
	readonly code: ExecutionContextErrorCode
	readonly details: Record<string, unknown> | undefined

	constructor(input: {
		status: number
		code: ExecutionContextErrorCode
		message: string
		details?: Record<string, unknown>
	}) {
		super(`${input.message} (${input.code})`)
		this.name = 'ExecutionContextError'
		this.status = input.status
		this.code = input.code
		this.details = input.details
	}
}

export function isExecutionContextError(
	error: unknown,
): error is ExecutionContextError {
	return error instanceof ExecutionContextError
}

export const registrationLoginCommand = 'kody login'

/**
 * Decision 15: an existing login never gains new scopes silently. A token
 * minted before execution context permissions existed fails registration
 * with this error, naming the exact command that fixes it.
 */
export function registrationAuthorizationError(error: unknown) {
	const code =
		error && typeof error === 'object' && 'code' in error
			? (error as { code: unknown }).code
			: null
	if (code === 'credential_scope') {
		return new ExecutionContextError({
			status: 403,
			code: 'insufficient_scope',
			message: `Your Kody login predates execution context permissions, so it cannot register a machine. Run \`${registrationLoginCommand}\` again, then retry \`kody context register\`.`,
			details: {
				reason: 'credential_scope',
				requiredScope: 'execution_context:create',
				loginCommand: registrationLoginCommand,
			},
		})
	}
	return new ExecutionContextError({
		status: 403,
		code: 'not_granted',
		message:
			'Registering an execution context in this org needs execution_context:create. An org Owner can grant it, or register in your personal org.',
		details: {
			reason: 'missing_permission',
			requiredScope: 'execution_context:create',
		},
	})
}
