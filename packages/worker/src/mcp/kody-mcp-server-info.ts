import type { Implementation } from '@modelcontextprotocol/sdk/types.js'
import { buildKodyToolIcons } from './tools/tool-icons.ts'

/**
 * Shared MCP `initialize` / `server/discover` serverInfo for both protocol
 * lanes. Keep `name` and `version` stable; title/description/websiteUrl/icons
 * are display metadata the SDK's Implementation type supports.
 */
export const kodyMcpServerName = 'kody-mcp' as const

/** Advertised on both protocol lanes and the public MCP server card. */
export const kodyMcpServerVersion = '1.0.0' as const

export const kodyMcpServerTitle = 'Kody' as const

export const kodyMcpServerWebsiteUrl = 'https://kody.codes' as const

/** One-line agent-facing purpose (Implementation.description). */
export const kodyMcpServerDescription =
	"Your agents' cloud: search the catalog and run sandboxed modules with credentials, packages, jobs, and integrations." as const

/**
 * Handshake / discover `serverInfo`. Icons always point at production absolute
 * URIs (same brand assets as `websiteUrl`), never the request origin — local
 * and preview hosts must not advertise `localhost` icon URLs to MCP clients.
 */
export function buildKodyMcpServerInfo(): Implementation {
	const icons = buildKodyToolIcons(kodyMcpServerWebsiteUrl)
	return {
		name: kodyMcpServerName,
		version: kodyMcpServerVersion,
		title: kodyMcpServerTitle,
		description: kodyMcpServerDescription,
		websiteUrl: kodyMcpServerWebsiteUrl,
		...(icons ? { icons } : {}),
	}
}
