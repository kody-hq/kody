import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { maxUserMcpServerInstructionsChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { describeUserMcpServerInstructionOverlay } from '#mcp/mcp-server-instruction-overlay.ts'
import { getMcpUserServerInstructions } from '#mcp/user-server-instructions-repo.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	instructions: z.string().nullable(),
	max_length: z.number().int().positive(),
	assembled_chars: z.number().int().nonnegative(),
	warning: z.string().nullable(),
})

export const metaGetMcpServerInstructionsCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaGetMcpServerInstructions',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'Read the signed-in user’s custom MCP server instructions overlay (if any). Empty means none. Same character limit as set. Put guidance at the right layer: see search({ entity: "guide:agent_guidance" }) (Where agent guidance lives / /docs/agent-guidance). Prefer memories for durable facts and preferences; the overlay is only for rare always-on session policy. Reports assembled_chars and a warning when some clients would truncate the overlay.',
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
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const instructions = await getMcpUserServerInstructions(
				ctx.env.APP_DB,
				user.userId,
			)
			const assembly = describeUserMcpServerInstructionOverlay({
				overlay: instructions,
			})
			return {
				instructions,
				max_length: maxUserMcpServerInstructionsChars,
				assembled_chars: assembly.assembled_chars,
				warning: assembly.warning,
			}
		},
	},
)
