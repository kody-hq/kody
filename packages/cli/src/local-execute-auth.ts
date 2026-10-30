import { type ensureFreshCredentials } from './auth.js'
import {
	notAuthenticatedMessage,
	expectedPairedApiOrigin,
	isPairedApiUrl,
	type ResolveScopedApiTokenInput,
} from './api-token.js'
import {
	noteActiveLoginCredential,
	resolveCliCredential,
} from './cli-credential.js'
import { defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { type SecretBackend } from './store.js'

function urlOriginOrValue(value: string): string {
	try {
		return new URL(value).origin
	} catch {
		return value
	}
}

/**
 * Bearer for CapabilityProxy / package-graph under `execute --local`.
 *
 * Priority:
 * 1. `--token` / `KODY_API_TOKEN`
 * 2. Stored bootstrap/API token from `auth bootstrap --code`
 * 3. Fresh `kody login` OAuth access token (never printed)
 *
 * No under-the-hood `tokenCreate` exchange. Do not scavenge host MCP tokens
 * (ADR 0053).
 */
export async function resolveLocalExecuteBearer(
	input: ResolveScopedApiTokenInput & {
		mcpUrl?: string
		org?: string
		backend?: SecretBackend
		fetchFn?: typeof fetch
		now?: number
		purpose?: string
		/** Test seam. */
		ensureCredentials?: typeof ensureFreshCredentials
	},
): Promise<string> {
	const credential = resolveCliCredential({
		tokenValues: input.tokenValues,
		env: input.env,
		apiUrl: input.apiUrl,
		mcpUrl: input.mcpUrl,
		...(input.org ? { org: input.org } : {}),
		...(input.loadApiToken ? { loadApiToken: input.loadApiToken } : {}),
		...(input.apiTokenBackend
			? { apiTokenBackend: input.apiTokenBackend }
			: {}),
		...(input.apiTokenResolution
			? { apiTokenResolution: input.apiTokenResolution }
			: {}),
		...(input.backend ? { loginBackend: input.backend } : {}),
	})
	if (credential?.token) return credential.token

	const apiUrl = input.apiUrl ?? defaultApiUrl
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	if (!isPairedApiUrl(apiUrl, mcpUrl)) {
		const apiOrigin = urlOriginOrValue(apiUrl)
		const mcpOrigin = urlOriginOrValue(mcpUrl)
		throw new Error(
			`kody login credentials for ${mcpOrigin} are only sent to ${expectedPairedApiOrigin(mcpUrl)}. For ${apiOrigin}, run \`kody auth bootstrap --code … --api-url ${apiOrigin}\` or set KODY_API_TOKEN.`,
		)
	}

	const ensure =
		input.ensureCredentials ??
		(await import('./auth.js')).ensureFreshCredentials
	try {
		const credentials = await ensure({
			mcpUrl: input.mcpUrl,
			org: input.org,
			backend: input.backend,
			fetchFn: input.fetchFn,
			now: input.now,
		})
		noteActiveLoginCredential({ login: credentials })
		return credentials.accessToken
	} catch (error) {
		// Preserve org-specific guidance from ensureFreshCredentials.
		if (
			error instanceof Error &&
			error.message.startsWith('No login stored for org "')
		) {
			throw error
		}
		throw new Error(notAuthenticatedMessage(input.purpose ?? 'execute --local'))
	}
}
