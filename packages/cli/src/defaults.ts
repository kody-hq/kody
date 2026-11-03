export const defaultMcpUrl = 'https://kody.codes/mcp'
/** Kody Open API origin; hosts CapabilityProxy for `execute --local`. */
export const defaultApiUrl = 'https://api.kody.codes'
export const apiTokenEnvVar = 'KODY_API_TOKEN'
export const defaultScopes = ['openid', 'profile', 'email'] as const
/**
 * Scopes `execute --local` of saved packages needs together. Mirrors the
 * worker's `localExecuteOrgPermissions` (a worker test keeps them in sync).
 */
export const localExecuteScopes = [
	'app:execute',
	'app:read',
	'email:read',
	'email:send',
	'integration:read',
	'integration:use',
	'job:execute',
	'job:read',
	'memory:read',
	'org:execute',
	'package:execute',
	'package:read',
	'secret:use',
] as const

export const keyringService = 'kody.codes'
/** Long enough to create an account and verify email mid-login. */
export const loginTimeoutMs = 15 * 60 * 1000
export const accessTokenSkewMs = 60_000
export const cliName = '@kodycodes/cli'
/** Fixed loopback port so CIMD can list an exact redirect URI. */
const oauthCallbackPort = 43742
const cliClientIdMetadataPath = '/oauth/cli-client-metadata.json'

export function cliClientMetadataUrl(mcpUrl: string): string {
	return new URL(cliClientIdMetadataPath, mcpUrl).href
}

export function cliRedirectUrl(port: number = oauthCallbackPort): URL {
	return new URL(`http://127.0.0.1:${port}/callback`)
}

const onboardingPath = '/onboarding'

export function onboardingUrl(mcpUrl: string): string {
	return new URL(onboardingPath, mcpUrl).href
}
