/**
 * Credentials on a context run (ADR 0083). The operator's own runs use their
 * credentials exactly as they would in Kody cloud. A run by anyone else uses
 * none. Credentialed requests always leave from Kody cloud, so values never
 * reach the machine.
 */
export type ContextRunCredentials = 'requester' | 'none'

type ContextRunIdentity = { operatorUserId: string; requesterUserId: string }

/**
 * The operator's own run has the same Kody access as the same run in Kody
 * cloud; the machine only adds its host folders and LAN.
 */
export function isOperatorContextRun(input: ContextRunIdentity) {
	return input.operatorUserId === input.requesterUserId
}

export function contextRunCredentials(
	input: ContextRunIdentity,
): ContextRunCredentials {
	return isOperatorContextRun(input) ? 'requester' : 'none'
}

/**
 * The stable credential ids a run may resolve, enforced by the credential
 * door on every resolution. Null leaves the requester's access unchanged;
 * empty lets none through.
 */
export function contextCredentialIds(
	credentials: ContextRunCredentials,
): ReadonlyArray<string> | null {
	return credentials === 'requester' ? null : []
}

/** Runtime calls that use a credential. */
export function isCredentialedRuntimeCall(name: string) {
	return (
		name === 'authenticatedFetch' ||
		name === 'gatewayFetch' ||
		name === 'oauthClientCredentials' ||
		name.startsWith('credentialClient')
	)
}
