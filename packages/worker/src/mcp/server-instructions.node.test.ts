import { expect, test } from 'vitest'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { preferLocalCliExecuteGuidance } from '#mcp/instructions/prefer-local-cli-execute-guidance.ts'
import {
	appendUserMcpServerInstructionOverlay,
	baseMcpServerInstructions,
	buildMcpServerInstructions,
	describeAssembledMcpServerInstructions,
	maxBaseMcpServerInstructionsChars,
} from './server-instructions.ts'

const overlayHeader = `---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):`

test('always-on stub stays under the soft character budget and prefers local', () => {
	expect(baseMcpServerInstructions.length).toBeLessThanOrEqual(
		maxBaseMcpServerInstructionsChars,
	)
	expect(baseMcpServerInstructions).toContain(preferLocalCliExecuteGuidance)
	expect(baseMcpServerInstructions).toContain(
		'npx -y @kodycodes/cli@latest execute --local',
	)
	expect(baseMcpServerInstructions).toContain('cliCredentialBootstrap')
	expect(baseMcpServerInstructions).not.toMatch(
		/execute` to run code in Kody's cloud/,
	)
})

test('buildMcpServerInstructions appends the user overlay after the stub', () => {
	const assembled = buildMcpServerInstructions('Prefer concise replies.')
	expect(assembled.startsWith(baseMcpServerInstructions)).toBe(true)
	expect(assembled).toContain(overlayHeader)
	expect(assembled.endsWith('Prefer concise replies.')).toBe(true)
	expect(assembled.indexOf(overlayHeader)).toBeGreaterThan(
		baseMcpServerInstructions.length,
	)
	expect(assembled.length).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(buildMcpServerInstructions(null)).toBe(baseMcpServerInstructions)
	expect(buildMcpServerInstructions('   ')).toBe(baseMcpServerInstructions)

	const headerOnly = appendUserMcpServerInstructionOverlay(
		baseMcpServerInstructions,
		'x',
	)
	expect(headerOnly.length - 1).toBeLessThan(
		mcpServerInstructionsClientHeadLimitChars,
	)
})

test('overlay warning fires only when assembled text meets the client cut', () => {
	const shortAssembled = buildMcpServerInstructions('Prefer concise replies.')
	expect(
		describeAssembledMcpServerInstructions({
			assembled: shortAssembled,
			hasOverlay: true,
		}),
	).toEqual({
		assembled_chars: shortAssembled.length,
		warning: null,
	})

	const fatAssembled = appendUserMcpServerInstructionOverlay(
		baseMcpServerInstructions,
		'O'.repeat(mcpServerInstructionsClientHeadLimitChars),
	)
	const fatWarning = describeAssembledMcpServerInstructions({
		assembled: fatAssembled,
		hasOverlay: true,
	})
	expect(fatAssembled.length).toBeGreaterThanOrEqual(
		mcpServerInstructionsClientHeadLimitChars,
	)
	expect(fatWarning.assembled_chars).toBe(fatAssembled.length)
	expect(fatWarning.warning).toMatch(/2048/)
	expect(fatWarning.warning).toMatch(/overlay may never reach the model/)

	expect(
		describeAssembledMcpServerInstructions({
			assembled: fatAssembled,
			hasOverlay: false,
		}).warning,
	).toBeNull()
})
