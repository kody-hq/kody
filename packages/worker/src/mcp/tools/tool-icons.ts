import type { McpToolIcon } from '#mcp/mcp-registration-agent.ts'

/**
 * Kody tool icons (protocol revision 2025-11-25, SEP-973). Servers must use
 * absolute URIs, so icons are derived from the caller's base URL at
 * registration time. Advertised by the stateless SDK v2 lane; the SDK v1
 * `McpAgent` lane ignores the config key. Returns `undefined` when the base
 * URL is unknown (some unit-test agents), which omits the field entirely.
 */
export function buildKodyToolIcons(
	baseUrl: string | null | undefined,
): Array<McpToolIcon> | undefined {
	if (!baseUrl) return undefined
	return [
		{
			src: new URL('/android-chrome-192x192.png', baseUrl).toString(),
			mimeType: 'image/png',
			sizes: ['192x192'],
		},
		{
			src: new URL('/android-chrome-512x512.png', baseUrl).toString(),
			mimeType: 'image/png',
			sizes: ['512x512'],
		},
	]
}
