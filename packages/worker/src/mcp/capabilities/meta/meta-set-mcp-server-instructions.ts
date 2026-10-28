import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { maxUserMcpServerInstructionsChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { describeUserMcpServerInstructionOverlay } from '#mcp/mcp-server-instruction-overlay.ts'
import {
	getMcpUserServerInstructions,
	saveMcpUserServerInstructions,
} from '#mcp/user-server-instructions-repo.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	max_length: z.number().int().positive(),
	/** Effective stored text after trim (null if cleared). */
	instructions: z.string().nullable(),
	assembled_chars: z.number().int().nonnegative(),
	warning: z.string().nullable(),
})

export const metaSetMcpServerInstructionsCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaSetMcpServerInstructions',
		contextRuns: 'allow',
		orgPermission: 'org:write',
		description:
			'Replace or clear the signed-in user’s custom MCP server instructions overlay (appended to built-in server instructions for new MCP connections). Put guidance at the right layer: see search({ entity: "guide:agent_guidance" }) (Where agent guidance lives / /docs/agent-guidance). Prefer memories for durable facts and preferences; use this overlay only for rare always-on session policy—not package inventory, export gotchas, or package docs. Pass an empty string to clear. Changes apply to new MCP sessions—reconnect the client if the host caches server instructions. Reports assembled_chars and a warning when some clients would truncate the overlay.',
		keywords: [
			'instructions',
			'server',
			'overlay',
			'preferences',
			'memory',
			'mcp',
			'prompt',
			'agent guidance',
			'progressive disclosure',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			instructions: z
				.string()
				.max(
					maxUserMcpServerInstructionsChars,
					`instructions must be at most ${maxUserMcpServerInstructionsChars} characters`,
				)
				.describe(
					'Full replacement text for the user overlay, or empty string to remove it.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			await saveMcpUserServerInstructions(
				ctx.env.APP_DB,
				user.userId,
				args.instructions,
			)
			const stored = await getMcpUserServerInstructions(
				ctx.env.APP_DB,
				user.userId,
			)
			const assembly = describeUserMcpServerInstructionOverlay({
				overlay: stored,
			})
			return {
				ok: true as const,
				max_length: maxUserMcpServerInstructionsChars,
				instructions: stored,
				assembled_chars: assembly.assembled_chars,
				warning: assembly.warning,
			}
		},
	},
)
