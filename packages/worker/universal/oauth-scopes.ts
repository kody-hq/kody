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
		return [
			`The "${name}" connection is a built-in (platform) integration that is being retired.`,
			`It currently requests these scopes: ${currentList}.`,
			`Do not call integrationSave to change authorization.scopes on a built-in — that capability refuses platform connections.`,
			`To change access or reconnect, set up a bring-your-own OAuth app at ${reconnectHref} (or a complete /connect/oauth URL after opening guide:oauth and the matching guide:provider_<slug>).`,
			`Reconnecting replaces this built-in connection with the user's own app. Existing tokens stay valid until then.`,
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
