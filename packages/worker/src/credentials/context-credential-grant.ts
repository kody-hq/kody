import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

/**
 * A run on an execution context tried to use a credential its context's
 * grant does not let through (ADR 0083). The value was never read.
 */
export class ContextCredentialNotGrantedError extends McpCallerError {
	readonly code = 'execution_context_credential_not_granted'
	constructor(label: string) {
		super(
			`This execution context's grant does not let the credential "${label}" through. Its operator can add it to the context's credential list, or run this on Kody cloud.`,
		)
		this.name = 'ContextCredentialNotGrantedError'
	}
}

/**
 * Checks a found credential against the run's context grant. A credential
 * with no stable id cannot be matched to the list, so it is refused too.
 */
export function assertContextGrantAllowsCredential(input: {
	actor: RequestContext | null
	credentialId: string | null
	label: string
}) {
	const allowed = input.actor?.credential.contextCredentialIds
	if (allowed == null) return
	if (input.credentialId != null && allowed.includes(input.credentialId)) {
		return
	}
	throw new ContextCredentialNotGrantedError(input.label)
}
