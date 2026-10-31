import { type StoredCredentials } from './store.js'

export { orgSlugFromFlag } from './org-slug.js'

/** Issuer stamp restored from durable CLI storage. */
export function issuerFromStoredCredentials(
	credentials: StoredCredentials,
): string {
	const recorded = credentials.authorizationServerUrl?.trim()
	if (recorded) return recorded
	return new URL(credentials.mcpUrl).origin
}
