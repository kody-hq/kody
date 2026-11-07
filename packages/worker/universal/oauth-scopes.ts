import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { buildIncompleteConnectOauthAgentPrompt } from '#universal/error-agent-prompt-presets.ts'

/**
 * Shared OAuth scope-menu helpers for the connect page and account
 * integrations UI. "Selected" is the requested list stored on a connection;
 * "allowed" is the operator-verified platform menu when one exists.
 */

export function uniqueOauthScopes(
	scopes: ReadonlyArray<string> | null | undefined,
): Array<string> {
	const seen = new Set<string>()
	const result: Array<string> = []
	for (const raw of scopes ?? []) {
		const scope = raw.trim()
		if (!scope || seen.has(scope)) continue
		seen.add(scope)
		result.push(scope)
	}
	return result
}

/**
 * Built-in menu first, then any already-selected scopes that are not on it
 * (query overrides / older grants). Bring-your-own connections have no menu,
 * so the selected list is the whole list.
 */
export function resolveOauthScopeMenu(input: {
	allowedScopes?: ReadonlyArray<string> | null
	selectedScopes: ReadonlyArray<string> | null | undefined
}): Array<string> {
	const selected = uniqueOauthScopes(input.selectedScopes)
	const allowed = uniqueOauthScopes(input.allowedScopes)
	if (allowed.length === 0) return selected
	return [...allowed, ...selected.filter((scope) => !allowed.includes(scope))]
}

export function formatOauthScopeDisclosureLabel(input: {
	selectedCount: number
	menuCount: number
}): string {
	const noun = input.selectedCount === 1 ? 'scope' : 'scopes'
	if (input.menuCount > input.selectedCount) {
		return `Change ${noun} (${input.selectedCount} of ${input.menuCount})`
	}
	return `Change the ${input.selectedCount} ${noun}`
}

export function formatOauthScopeSummary(input: {
	selectedCount: number
	menuCount: number
}): string {
	if (input.menuCount > input.selectedCount && input.menuCount > 0) {
		return `${input.selectedCount} of ${input.menuCount} scopes`
	}
	const noun = input.selectedCount === 1 ? 'scope' : 'scopes'
	return `${input.selectedCount} ${noun}`
}

export function buildIncompleteConnectOauthPrompt(input: {
	provider: string
}): string {
	const providerKey = normalizeProviderKey(input.provider)
	return buildIncompleteConnectOauthAgentPrompt({
		provider: providerKey || 'this provider',
	})
}

export function buildChangeIntegrationScopesPrompt(input: {
	name: string
	platform: boolean
	currentScopes: ReadonlyArray<string> | null | undefined
	allowedScopes?: ReadonlyArray<string> | null
	/** Team org that owns the connection; omit for the personal org. */
	orgSlug?: string | null
}): string {
	const name = input.name.trim() || 'this'
	const current = uniqueOauthScopes(input.currentScopes)
	const currentList =
		current.length > 0
			? current.map((scope) => `\`${scope}\``).join(', ')
			: 'none'
	const orgSlug = input.orgSlug?.trim()
	const reconnectHref = `/connect/oauth?provider=${encodeURIComponent(name)}${orgSlug ? `&org=${encodeURIComponent(orgSlug)}` : ''}`
	if (input.platform) {
		const allowed = uniqueOauthScopes(input.allowedScopes)
		const allowedList =
			allowed.length > 0
				? allowed.map((scope) => `\`${scope}\``).join(', ')
				: 'none listed'
		return [
			`Change the scopes on the "${name}" connection. It is a built-in (platform) connection and stays built-in.`,
			`It currently requests: ${currentList}. Scopes this built-in supports: ${allowedList}.`,
			`Call integrationGet first. Then call integrationSave with name and authorization (the current authorizeUrl plus the full scope list this connection should request). You can add or remove scopes, but only supported ones, and at least one.`,
			`This changes only this connection. The built-in defaults and every other connection keep their scopes.`,
			`The current token keeps its old access until I reconnect. Tell me that in plain words and ask whether I want to reconnect at ${reconnectHref}, where the provider asks me to approve the new scopes.`,
			`After I reconnect, integrationGet shows grantedScopes: what the provider actually granted, with missing and extra scopes versus the request. If either list is not empty, tell me. Do not say the scopes changed when the grant did not.`,
		].join(' ')
	}
	return [
		`Add the scopes I need to the "${name}" OAuth integration.`,
		`authorization.scopes is reconnect metadata — the list the next /connect/oauth visit will request — not the current access token.`,
		`It currently requests: ${currentList}.`,
		`Open search({ entity: "guide:oauth" }) and, if a provider guide exists, search({ entity: "guide:provider_<slug>" }).`,
		`Call integrationGet / integrationList first. Scopes are per connection; sibling accounts that share an OAuth app keep their own scope lists.`,
		`Use integrationSave to widen authorization.scopes on this connection only.`,
		`Then tell me in plain language that the saved integration now requests those scopes but existing tokens do not, and ask whether I want to reconnect this account (and any other accounts I name) at ${reconnectHref}.`,
	].join(' ')
}

/**
 * Plain-words note for a connect whose granted scopes differ from the
 * request. Null when they match or the provider does not report the grant.
 */
export function formatScopeGrantNotice(
	grant:
		| {
				granted: ReadonlyArray<string> | null
				missing: ReadonlyArray<string>
				extra: ReadonlyArray<string>
		  }
		| null
		| undefined,
): string | null {
	if (!grant || grant.granted == null) return null
	const parts: Array<string> = []
	if (grant.missing.length > 0) {
		parts.push(`Not granted: ${grant.missing.join(', ')}.`)
	}
	if (grant.extra.length > 0) {
		parts.push(
			`The provider kept scopes this connection no longer requests: ${grant.extra.join(', ')}. The token still has them.`,
		)
	}
	return parts.length > 0 ? parts.join(' ') : null
}

/** Detail-row text for the scopes a provider actually granted. */
export function formatGrantedScopesDetail(
	granted:
		| { scopes: ReadonlyArray<string>; source: string; checkedAt: string }
		| null
		| undefined,
): string {
	if (!granted) return 'Not checked yet. Reconnect to record it.'
	const list = granted.scopes.length > 0 ? granted.scopes.join(', ') : 'none'
	const via =
		granted.source === 'github-x-oauth-scopes'
			? 'checked with GitHub'
			: 'reported by the token response'
	return `${list} (${via})`
}
