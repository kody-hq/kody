export const defaultMcpUrl = 'https://kody.codes/mcp'
/** Kody Open API origin; hosts CapabilityProxy for `execute --local`. */
export const defaultApiUrl = 'https://api.kody.codes'
export const apiTokenEnvVar = 'KODY_API_TOKEN'
export const defaultScopes = ['openid', 'profile', 'email'] as const

export const keyringService = 'kody.codes'
export const loginTimeoutMs = 5 * 60 * 1000
export const accessTokenSkewMs = 60_000
export const cliName = '@kodycodes/cli'
export const cliClientUri = 'https://github.com/kody-hq/kody'
/** Fixed loopback port so CIMD can list an exact redirect URI. */
export const oauthCallbackPort = 43742
export const cliClientIdMetadataPath = '/oauth/cli-client-metadata.json'

export function cliClientMetadataUrl(mcpUrl: string): string {
	return new URL(cliClientIdMetadataPath, mcpUrl).href
}

export function cliRedirectUrl(port: number = oauthCallbackPort): URL {
	return new URL(`http://127.0.0.1:${port}/callback`)
}

export const onboardingPath = '/onboarding'

export function onboardingUrl(mcpUrl: string): string {
	return new URL(onboardingPath, mcpUrl).href
}
