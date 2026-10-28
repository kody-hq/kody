/**
 * Why an authorize request could not resolve its OAuth client, in a shape the
 * authorize page, the decision RPC, and the "copy prompt for your agent" text
 * share. Never carries the raw client_id: the metadata host and a normalized
 * path are enough to act on.
 */
export type OAuthAuthorizeClientFailure = (
	| {
			kind: 'metadata_fetch'
			/** Host serving the client's metadata document, e.g. `chatgpt.com`. */
			host: string
			/** HTTP status when the host answered, else null. */
			status: number | null
			/** `http_404`, `timeout`, `network_error`, or `invalid_document`. */
			errorType: string
			client: 'codex' | 'chatgpt' | 'other'
	  }
	| { kind: 'missing_registration' }
) & {
	/** Kody origin the client connects to, e.g. `https://kody.codes`. */
	kodyOrigin?: string
	/** ISO time the failure was seen. */
	at?: string
}

/** `2026-10-23 23:40 UTC` (deterministic for server render and hydration). */
export function formatOAuthAuthorizeFailureTime(at: string | undefined) {
	if (!at) return null
	const date = new Date(at)
	if (Number.isNaN(date.getTime())) return null
	return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Short status text: `HTTP 404`, `timed out`, `network error`, ... */
export function oauthAuthorizeFetchStatusLabel(failure: {
	status: number | null
	errorType: string
}) {
	if (failure.status !== null) return `HTTP ${failure.status}`
	switch (failure.errorType) {
		case 'timeout':
			return 'timed out'
		case 'network_error':
			return 'network error'
		case 'invalid_document':
			return 'invalid document'
		default:
			return failure.errorType.replaceAll('_', ' ')
	}
}

export function oauthAuthorizeClientDisplayName(
	failure: OAuthAuthorizeClientFailure,
) {
	if (failure.kind !== 'metadata_fetch') return 'this app'
	if (failure.client === 'codex') return 'Codex'
	if (failure.client === 'chatgpt') return 'ChatGPT'
	return 'this app'
}

/** One-sentence error for alerts, the decision RPC, and the prompt. */
export function oauthAuthorizeClientFailureMessage(
	failure: OAuthAuthorizeClientFailure,
) {
	if (failure.kind === 'missing_registration') {
		return "Kody has no registration for this app's connection. Log out of Kody in your app and sign in again, or remove Kody from the app and add it again."
	}
	const name = oauthAuthorizeClientDisplayName(failure)
	const owner = name === 'this app' ? "this app's" : `${name}'s`
	return `Kody could not load ${owner} client details from ${failure.host} (${oauthAuthorizeFetchStatusLabel(failure)}). This is a problem on the app's side, not with your Kody account.`
}

/** The Codex CLI override for a CIMD fetch failure. */
export const codexDcrLoginCommand =
	'codex mcp login <server> --oauth-client-registration dcr'
