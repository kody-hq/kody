import { preferLocalCliExecuteGuidance } from '#mcp/instructions/prefer-local-cli-execute-guidance.ts'
import { mcpServerInstructionsClientHeadLimitChars } from '#mcp/mcp-user-server-instruction-limits.ts'

/**
 * Neutral always-on MCP server instructions. Kept short so clients that
 * truncate the head (often ~2048 characters) still see how to use search /
 * execute. No prefer-over-host wording — package lifecycle and host-vs-Kody
 * guidance belong in skills / guides, not this stub.
 *
 * Copy is Kent-locked; change only with an explicit server-instructions update.
 * Prefer-local one-liner is {@link preferLocalCliExecuteGuidance} (shared with
 * execute + api tool descriptions).
 */
export const baseMcpServerInstructions = `Kody is Your agents' cloud: a software platform of primitives for individuals and teams including:

- memory
- credentials
- packages (published code you compose)
- integrations
- triggers
- apps

${preferLocalCliExecuteGuidance}

When you need the Kody CLI and are not signed in, bootstrap it yourself with \`cliCredentialBootstrap\` and do not ask the human for a token.

When the user asks you to do something, start with \`search\`, then \`execute\` to run code in Kody's cloud.

Learn more with \`search({ entity: "guide:local_execute" })\`.`

/** Soft budget for the always-on stub (excluding user overlay). Kent-locked ~300–600. */
export const maxBaseMcpServerInstructionsChars = 600

const userMcpServerInstructionOverlayHeader = `---
User-provided MCP instructions (follow these when they do not conflict with safety or tool contracts):`

export function appendUserMcpServerInstructionOverlay(
	base: string,
	userOverlay: string | null | undefined,
): string {
	const trimmed = userOverlay?.trim()
	if (!trimmed) return base
	return `${base}

${userMcpServerInstructionOverlayHeader}
${trimmed}`
}

export function buildMcpServerInstructions(
	userOverlay?: string | null | undefined,
): string {
	return appendUserMcpServerInstructionOverlay(
		baseMcpServerInstructions,
		userOverlay,
	)
}

export function describeAssembledMcpServerInstructions(input: {
	assembled: string
	hasOverlay: boolean
}): { assembled_chars: number; warning: string | null } {
	const assembled_chars = input.assembled.length
	if (
		!input.hasOverlay ||
		assembled_chars < mcpServerInstructionsClientHeadLimitChars
	) {
		return { assembled_chars, warning: null }
	}
	return {
		assembled_chars,
		warning: `Assembled MCP server instructions are ${String(assembled_chars)} characters. Some clients keep only the first ${String(mcpServerInstructionsClientHeadLimitChars)} characters, so this overlay may never reach the model. Prefer memories for durable facts; keep the overlay short.`,
	}
}
