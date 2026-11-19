import { z } from 'zod'
import { runSearchTool } from '#mcp/tools/search-tool-runner.ts'
import { searchToolInputSchema } from '#mcp/tools/search-tool-definition.ts'
import {
	parseNativeInput,
	type NativeApiOperationDefinition,
} from './native-operation-helpers.ts'

const searchToolHttpInputSchema = z.object(searchToolInputSchema)

export const searchToolHttpOutputSchema = z.object({
	content: z.array(z.unknown()),
	structuredContent: z.record(z.string(), z.unknown()),
	isError: z.boolean(),
})

/**
 * MCP `search` tool over HTTP, including `--entity` detail. Distinct from
 * the `search` capability at `GET /v1/search`.
 */
export const searchToolOperationDefinition: NativeApiOperationDefinition = {
	summary: 'Search catalog (CLI / MCP search tool)',
	description:
		'Same catalog search as the MCP `search` tool, including exact `entity` refs. Requires `search:read`. The result envelope matches the tool (`content`, `structuredContent`, `isError`). `GET /v1/search` remains the capability.',
	inputSchema: searchToolHttpInputSchema,
	outputSchema: searchToolHttpOutputSchema,
	readOnly: true,
	async handler(params, ctx) {
		const args = parseNativeInput(searchToolHttpInputSchema, params)
		const result = await runSearchTool({
			env: ctx.env,
			callerContext: ctx.callerContext,
			args,
		})
		return { ...result, isError: result.isError ?? false }
	},
}
