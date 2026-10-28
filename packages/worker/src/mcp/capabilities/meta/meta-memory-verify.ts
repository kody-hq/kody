import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { verifyMemoryCandidate } from '#mcp/memory/service.ts'
import {
	memoryRecordSchema,
	memorySourceUriSchema,
	memoryVerifyInputSchema,
} from './meta-memory-shared.ts'
import {
	memoryPersonalOnlyOrgPermission,
	personalMemoryReadScope,
} from './meta-memory-owner.ts'

const recommendedActions: Array<
	'upsert' | 'delete' | 'upsert_and_delete' | 'none'
> = ['upsert', 'delete', 'upsert_and_delete', 'none']

const relatedMemorySchema = memoryRecordSchema
	.pick({
		id: true,
		category: true,
		status: true,
		subject: true,
		summary: true,
		tags: true,
		source_uris: true,
		dedupe_key: true,
	})
	.extend({
		score: z.number(),
	})

const outputSchema = z.object({
	candidate: z.object({
		subject: z.string(),
		summary: z.string(),
		category: z.string().nullable(),
		tags: z.array(z.string()),
		source_uris: z.array(memorySourceUriSchema).optional(),
		dedupe_key: z.string().nullable(),
	}),
	related_memories: z.array(relatedMemorySchema),
	recommended_actions: z.array(
		z.enum(['upsert', 'delete', 'upsert_and_delete', 'none']),
	),
})

export const metaMemoryVerifyCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaMemoryVerify',
		contextRuns: 'allow',
		orgPermission: memoryPersonalOnlyOrgPermission,
		description:
			'Always run this before writing or deleting **personal** memory (always the signed-in person\'s personal org, regardless of which org this connection uses). Submit the candidate, review related memories, then decide whether to upsert, delete, both, or do nothing. Do not upsert blindly. Do not copy a personal memory into an org package without asking the person first — shared org knowledge belongs in documented packages and org instructions. If the candidate is really package- or export-scoped guidance, update package docs or JSDoc instead (see search({ entity: "guide:agent_guidance" })).',
		keywords: [
			'memory',
			'verify',
			'related memories',
			'dedupe',
			'search',
			'personal memory',
			'agent guidance',
			'package docs',
			'jsdoc',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: memoryVerifyInputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const { auth, scope } = await personalMemoryReadScope(ctx)
			const result = await verifyMemoryCandidate({
				env: ctx.env,
				userId: auth.userId,
				scope,
				candidate: {
					category: args.category ?? null,
					subject: args.subject,
					summary: args.summary,
					details: args.details ?? null,
					tags: args.tags ?? null,
					sourceUris: args.source_uris ?? null,
					dedupeKey: args.dedupe_key ?? null,
				},
				limit: args.limit,
				conversationId: args.conversation_id ?? null,
				includeSuppressedInConversation:
					args.include_suppressed_in_conversation ?? false,
			})
			return {
				candidate: formatCandidate(result.candidate),
				related_memories: result.relatedMemories.map((match) =>
					formatMemoryMatch(match.memory, match.score),
				),
				recommended_actions: recommendedActions,
			}
		},
	},
)

function formatMemoryMatch(
	match: {
		id: string
		category: string | null
		status: 'active' | 'deleted' | 'archived'
		subject: string
		summary: string
		tags: Array<string>
		sourceUris: Array<string>
		dedupeKey: string | null
	},
	score: number,
) {
	return {
		id: match.id,
		category: match.category,
		status: match.status,
		subject: match.subject,
		summary: match.summary,
		tags: match.tags,
		source_uris: match.sourceUris,
		dedupe_key: match.dedupeKey,
		score,
	}
}

function formatCandidate(candidate: {
	subject: string
	summary: string
	category: string | null
	tags: Array<string>
	source_uris: Array<string>
	dedupe_key: string | null
}) {
	return {
		subject: candidate.subject,
		summary: candidate.summary,
		category: candidate.category,
		tags: candidate.tags,
		source_uris: candidate.source_uris,
		dedupe_key: candidate.dedupe_key,
	}
}
