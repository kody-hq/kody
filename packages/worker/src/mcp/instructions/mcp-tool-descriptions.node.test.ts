import { expect, test } from 'vitest'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { searchTool } from '#mcp/tools/search-tool-definition.ts'

test('search and execute tool descriptions fit a 2048-character client cut', () => {
	expect(searchTool.description.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(executeToolDescription.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
})
