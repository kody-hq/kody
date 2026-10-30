/**
 * Credentials on a context run (ADR 0083). The operator's own runs use their
 * credentials exactly as they would in Kody cloud. A run by anyone else uses
 * none. Credentialed requests always leave from Kody cloud, so values never
 * reach the machine.
 */
export type ContextRunCredentials = 'requester' | 'none'

export function contextRunCredentials(input: {
	operatorUserId: string
	requesterUserId: string
}): ContextRunCredentials {
	return input.operatorUserId === input.requesterUserId ? 'requester' : 'none'
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
