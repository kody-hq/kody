import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { maxBatchEntityRefs } from './search-constants.ts'
import type { StructuredContentFromFields } from './mcp-tool-output.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
} from './tool-call-context.ts'

export const searchTool = {
	name: 'search',
	title: 'Search catalog',
	description: `
Find built-in capabilities, official guides, saved packages, integrations, connected MCP servers, and secret references (metadata only) before \`execute\`. Prefer short task phrases over keyword lists.

**query** — compact ranked markdown + structured matches (same actionable substance on both channels; major MCP clients usually load one). Empty or broad queries return a domain index; search again with a more specific query. Domain ids appear on capability hits. Connected MCP servers appear as server hits (name, instructions); do not expect every remote tool in unscoped results. Prefer a matching package export hit over only the parent package when it fits the task. High-confidence export hits may include an inlined call contract (import + types + execute example) on both markdown and structured — use it; otherwise open \`entity\` for the full contract.

**entity: "{type}:{id}"** — detail for one hit (\`capability\` | \`guide\` | \`integration\` | \`mcp-server\` | \`package\` | \`secret\`), or 1–10 refs. The first \`:\` is the type; ids may contain colons (\`capability:mcp:home:set_pin\`). Guide detail is the full markdown when it fits the response budget; oversized guides return a table of contents. Open a heading with \`guide:{id}#{slug}\` or lines with \`guide:{id}#L165\` / \`#L165-L180\`. Open one export with \`package:{id}#{subpath}\` (for example \`package:home-controls#bond-area-shades\`). Open one file with \`package:{id}#README.md#slug\` or \`package:{id}#src/file.ts#L165\`. An export subpath still wins. Capability detail includes an execute snippet. MCP server detail lists discovered tools; after that, call \`kody.mcp["name"].tool_name(args)\`.

Example arguments:
- \`{ "query": "send a message" }\`
- \`{}\`
- \`{ "query": "send a message", "domain": "email" }\`
- \`{ "domain": "jobs" }\`
- \`{ "entity": "guide:package_authoring" }\`

https://raw.githubusercontent.com/kody-hq/kody/main/docs/use/search.md
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

export const searchToolInputSchema = {
	query: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Natural language description, or a scoped `@owner/leaf` name, current-origin account package URL, owner-matching hosted package URL, or an exact saved-package UUID (`package_id`) when the name is not known.',
		),
	entity: z
		.union([
			z.string().min(1),
			z.array(z.string().min(1)).min(1).max(maxBatchEntityRefs),
		])
		.optional()
		.describe(
			'Optional exact entity reference "{type}:{id}" (capability, guide, integration, mcp-server, package, or secret), or an array of refs to batch related detail lookups. Guide refs accept "#{heading}" or a line anchor "#L165" / "#L165-L180". Package refs accept "#{subpath}" to open one export contract (leading "./" is optional), or "#{path}" / "#{path}#L165" / "#{path}#heading" to open one file. A fragment that matches an export subpath still opens that export. Use "mcp-server:{name}" to list tools on a connected MCP server.',
		),
	domain: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional capability domain id (for example "email" or "mcp:linear"). With "query", ranks only that domain\'s capabilities; without "query", lists the domain\'s capabilities.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Number of ranked results to return. Defaults to 15.'),
	maxResponseSize: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			'Response size budget before trimming low-ranked results. Defaults to 4000.',
		),
	conversationId: conversationIdInputField,
	memoryContext: memoryContextInputField,
	includeHiddenPackages: z
		.boolean()
		.optional()
		.describe(
			'Include hidden packages in search results (hidden packages are excluded by default).',
		),
}

/**
 * Advertised MCP output schema for the search tool's `structuredContent`
 * envelope. This record is the single source of truth for tools/list JSON
 * Schema and {@link SearchToolStructuredContent}. Keep every top-level key
 * the runner emits here — strict clients reject undeclared fields
 * (`additionalProperties: false`). Compound values stay `z.unknown()` so
 * server-side Zod validation never rejects a real response; mode-specific
 * payload shapes stay in the tool description and docs.
 */
export const searchToolOutputSchema = {
	conversationId: z
		.string()
		.optional()
		.describe(
			'Tool conversation id; pass it back on subsequent search/execute calls.',
		),
	timing: z
		.unknown()
		.optional()
		.describe(
			'Server-side timing: startedAt, endedAt, durationMs, optional serverTiming phases.',
		),
	result: z
		.unknown()
		.optional()
		.describe(
			'Mode-specific structured payload: ranked matches with telemetry, domain browse listing, entity detail, or entity-batch results.',
		),
	error: z
		.string()
		.optional()
		.describe('Error summary when the search failed (isError is set).'),
	entitlement: z
		.unknown()
		.optional()
		.describe(
			'Focused plan-limit or quota fields when a call is denied. Omitted from ordinary successes.',
		),
	rateLimit: z
		.unknown()
		.optional()
		.describe(
			'Abuse rate-limit fields when search is refused (code, window, retryAfterSeconds, limit, plan). Omitted otherwise.',
		),
}

export type SearchToolStructuredContent = StructuredContentFromFields<
	typeof searchToolOutputSchema
>

export type SearchToolArgs = {
	query?: string
	entity?: string | Array<string>
	domain?: string
	limit?: number
	maxResponseSize?: number
	conversationId?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
	includeHiddenPackages?: boolean
}
