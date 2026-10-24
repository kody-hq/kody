/**
 * Client ID Metadata Documents Kody knows without fetching them.
 *
 * Since 2026-10-22, chatgpt.com answers Cloudflare Worker fetches of OpenAI's
 * CIMD documents with HTTP 404 (and earlier with 403 challenge pages), while
 * the same URLs return 200 everywhere else. A client the provider cannot
 * resolve gets "unknown client" on authorize and `invalid_client` on every
 * refresh, so Codex could not connect at all.
 *
 * Two tiers, both validated by the provider exactly like a fetched document:
 *
 * - Pinned (never fetched): Codex's native-app documents. They are static,
 *   loopback-only, and public (`token_endpoint_auth_method: none`), so
 *   freezing them cannot widen who can receive a code. Same approach as
 *   Sentry's patch upstreamed in cloudflare/workers-oauth-provider#333.
 *   `https://chatgpt.com/oauth/codex/<callback_id>/client.json` is a fixed
 *   template (redirects `http://127.0.0.1/callback/<callback_id>` and
 *   `http://localhost/callback/<callback_id>`), so it is pinned by pattern.
 * - Built-in fallback (live first): ChatGPT's web connector document. It names
 *   a JWKS and `private_key_jwt`, which OpenAI may rotate or change, so Kody
 *   keeps using the live copy and only falls back to this one (after any newer
 *   last known good copy) when an allowlisted host fails.
 *
 * Owner: Kody. These do not follow upstream changes. When OpenAI changes a
 * document, update it here from the source URL.
 */

export const codexStableClientId = 'https://chatgpt.com/oauth/codex/client.json'
export const chatgptClientId = 'https://chatgpt.com/oauth/client.json'

const codexCallbackClientIdPattern =
	/^https:\/\/chatgpt\.com\/oauth\/codex\/([A-Za-z0-9_-]{1,64})\/client\.json$/

function codexDocument(clientId: string, callbackPath: string) {
	return {
		client_id: clientId,
		client_uri: 'https://chatgpt.com/codex',
		application_type: 'native',
		redirect_uris: [
			`http://127.0.0.1${callbackPath}`,
			`http://localhost${callbackPath}`,
		],
		token_endpoint_auth_method: 'none',
		token_endpoint_auth_methods_supported: ['none'],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		client_name: 'Codex',
		logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
	}
}

/**
 * Pinned document for a client_id, or undefined. Passed to the provider as
 * `clientIdMetadataDocuments` (Kody patch of workers-oauth-provider 1.2.1).
 */
export function pinnedCimdDocument(clientId: string) {
	if (clientId === codexStableClientId) {
		return codexDocument(clientId, '/callback')
	}
	const callback = codexCallbackClientIdPattern.exec(clientId)
	if (callback) return codexDocument(clientId, `/callback/${callback[1]}`)
	return undefined
}

const builtInFallbackDocuments: Readonly<Record<string, unknown>> = {
	[chatgptClientId]: {
		client_id: chatgptClientId,
		client_uri: 'https://chatgpt.com/',
		redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
		token_endpoint_auth_method: 'private_key_jwt',
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		client_name: 'ChatGPT',
		logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
		token_endpoint_auth_signing_alg: 'RS256',
		jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
	},
}

/** Last-resort document for a known client whose host is failing. */
export function builtInFallbackCimdDocument(clientId: string) {
	return Object.prototype.hasOwnProperty.call(
		builtInFallbackDocuments,
		clientId,
	)
		? builtInFallbackDocuments[clientId]
		: undefined
}

/**
 * Hosts known to refuse Cloudflare Worker fetches of their CIMD documents
 * (404 or 403 to Workers, 200 elsewhere). For these, a 401/403/404 counts as
 * an outage, not a withdrawn document, and may use a last known good copy.
 */
const workerBlockedCimdHosts = new Set(['chatgpt.com'])

export function isWorkerBlockedCimdHost(clientId: string) {
	try {
		return workerBlockedCimdHosts.has(new URL(clientId).hostname)
	} catch {
		return false
	}
}

export type KnownCimdClientKind = 'codex' | 'chatgpt' | 'other'

export function knownCimdClientKind(clientId: string): KnownCimdClientKind {
	// Any chatgpt.com/oauth/codex/ document, pinned or not, is Codex.
	if (clientId.startsWith('https://chatgpt.com/oauth/codex/')) return 'codex'
	if (clientId === chatgptClientId) return 'chatgpt'
	return 'other'
}

/**
 * Host plus a path with per-install ids replaced, safe for logs and UI.
 * `https://chatgpt.com/oauth/codex/abc123/client.json` becomes
 * `chatgpt.com` + `/oauth/codex/<callback_id>/client.json`.
 */
export function normalizeCimdClientId(clientId: string) {
	try {
		const url = new URL(clientId)
		const callback = codexCallbackClientIdPattern.exec(clientId)
		if (callback) {
			return {
				host: url.hostname,
				path: '/oauth/codex/<callback_id>/client.json',
			}
		}
		const segments = url.pathname.split('/')
		const path = segments
			.map((segment, index) =>
				index === segments.length - 1 ||
				segment === '' ||
				/^[a-z][a-z._-]*$/.test(segment)
					? segment
					: '<id>',
			)
			.join('/')
		return { host: url.hostname, path: path.slice(0, 200) }
	} catch {
		return { host: 'unknown', path: '' }
	}
}
