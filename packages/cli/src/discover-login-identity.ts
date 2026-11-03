import { defaultApiUrl } from './defaults.js'
import type { LoginCallbackAccount } from './login-callback-page.js'
import { orgSlugFromFlag } from './org-slug.js'
import { openApiGet } from './open-api-client.js'

export type LoginIdentity = {
	org: string
	account: LoginCallbackAccount
}

/**
 * Resolve org + harmless account fields for a device `kody_at_` via
 * `GET /v1/me` (`metaGetCurrentUser`).
 */
export async function discoverLoginIdentity(input: {
	mcpUrl: string
	accessToken: string
	apiUrl?: string
	/** Org the login should bind. Sent as `?org=` so a team login is not the personal org. */
	org?: string
	fetchFn?: typeof fetch
}): Promise<LoginIdentity> {
	const payload = await openApiGet({
		token: input.accessToken,
		apiUrl: input.apiUrl ?? defaultApiUrl,
		path: 'v1/me',
		fetchFn: input.fetchFn,
		...(input.org ? { org: input.org } : {}),
	})
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error(
			'Could not determine the organization for this login (metaGetCurrentUser returned no result).',
		)
	}
	const record = payload as {
		org?: { slug?: unknown }
		email?: unknown
		display_name?: unknown
		username?: unknown
	}
	const orgSlug = typeof record.org?.slug === 'string' ? record.org.slug : null
	if (!orgSlug) {
		throw new Error(
			'Could not determine the organization for this login (metaGetCurrentUser returned no org.slug).',
		)
	}
	const account: LoginCallbackAccount = {}
	if (typeof record.display_name === 'string' && record.display_name.trim()) {
		account.displayName = record.display_name.trim()
	}
	if (typeof record.email === 'string' && record.email.trim()) {
		account.email = record.email.trim()
	}
	if (typeof record.username === 'string' && record.username.trim()) {
		account.username = record.username.trim()
	}
	return {
		org: orgSlugFromFlag(orgSlug),
		account,
	}
}
