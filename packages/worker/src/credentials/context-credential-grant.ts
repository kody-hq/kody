import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

/**
 * A run on someone else's execution context tried to use a credential
 * (ADR 0083). The value was never read.
 */
export class ContextCredentialNotGrantedError extends McpCallerError {
	readonly code = 'execution_context_credential_not_granted'
	constructor(label: string) {
		super(
			`Only this execution context's operator can use credentials in runs on it, so the credential "${label}" cannot be used here. Run this on Kody cloud, or on a context you operate.`,
		)
		this.name = 'ContextCredentialNotGrantedError'
	}
}

/**
 * Checks a found credential against the ids the run's context lets through
 * (`contextCredentialIds`; null does not narrow).
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
