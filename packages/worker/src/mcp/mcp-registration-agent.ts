import { type McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type McpServer as McpServerV2 } from '@modelcontextprotocol/server'
import {
	type CallToolResult,
	type GetPromptResult,
	type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { type z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpToolCallExtra } from './progress.ts'

/**
 * Tool icon metadata (protocol revision 2025-11-25, SEP-973). Advertised by
 * the stateless SDK v2 lane; the SDK v1 `McpAgent` lane has no icon support
 * and ignores the config key at runtime (its `registerTool` destructures only
 * the keys it knows), so one shared config serves both lanes.
 */
export type McpToolIcon = {
	src: string
	mimeType?: string
	sizes?: Array<string>
}

export type McpToolConfig = {
	title?: string
	description?: string
	/** Raw shape, or an object schema when the tool needs object-level checks. */
	inputSchema?: Record<string, z.ZodType> | z.ZodObject
	outputSchema?: Record<string, z.ZodType>
	annotations?: ToolAnnotations
	icons?: Array<McpToolIcon>
}

export type McpPromptConfig = {
	title?: string
	description?: string
	argsSchema?: Record<string, z.ZodType>
}

/**
 * The registration surface kody's tools and prompts use, satisfied by both
 * MCP server generations: `@modelcontextprotocol/sdk` v1 (`McpAgent`
 * Durable Object lane, 2025-era protocol revisions) and
 * `@modelcontextprotocol/server` v2 (stateless lane, 2026-07-28). Both
 * accept the raw-shape (or object-schema) config form with a callback returning content +
 * structured content (tools) or prompt messages, so one registration
 * definition backs both lanes and they can never drift apart.
 *
 * Tool callbacks accept an optional second argument so handlers can read
 * `_meta.progressToken` and emit `notifications/progress` (SDK v1
 * `RequestHandlerExtra` / SDK v2 `ServerContext`). The args parameter is
 * typed `never` so any concrete argument type is accepted; call sites
 * annotate their args explicitly and the concrete server validates inputs
 * against `inputSchema` at runtime.
 */
export type McpToolServer = {
	registerTool(
		name: string,
		config: McpToolConfig,
		cb: (
			args: never,
			extra?: McpToolCallExtra,
		) => CallToolResult | Promise<CallToolResult>,
	): unknown
	registerPrompt(
		name: string,
		config: McpPromptConfig,
		cb: (
			args: never,
			extra?: McpToolCallExtra,
		) => GetPromptResult | Promise<GetPromptResult>,
	): unknown
}

/**
 * Bridge one concrete server generation onto the shared registration
 * surface. Runtime-compatible by construction (both generations implement
 * the raw-shape `registerTool` / `registerPrompt` forms); the cast only
 * bridges the two SDKs' incompatible generic signatures, which TypeScript
 * cannot relate directly.
 */
export function asMcpToolServer(server: McpServerV1 | McpServerV2) {
	return server as unknown as McpToolServer
}

export type McpRegistrationAgent = {
	server: McpToolServer
	getEnv(): Env
	getCallerContext(): McpCallerContext
	requireDomain(): string
	getLoopbackExports(): Cloudflare.Exports
	/**
	 * Durable Object `ctx.waitUntil`, when the agent runs inside one. Tool
	 * handlers hand observability writes (run records, usage) to it so those
	 * writes do not serialize the response they observe.
	 */
	waitUntil?(promise: Promise<unknown>): void
}
