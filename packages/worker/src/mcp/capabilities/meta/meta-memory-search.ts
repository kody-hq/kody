import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	memorySearchMutationGuidance,
	searchMemoryRecords,
} from '#mcp/memory/service.ts'
import { memoryMatchSchema, verifyFirstWarning } from './meta-memory-shared.ts'
import {
	memoryPersonalOnlyOrgPermission,
	personalMemoryReadScope,
} from './meta-memory-owner.ts'

const mutableMemoryMatchSchema = memoryMatchSchema.extend({
	can_mutate: z.boolean(),
	mutation_guidance: z.string(),
})

export const metaMemorySearchCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaMemorySearch',
		contextRuns: 'allow',
		orgPermission: memoryPersonalOnlyOrgPermission,
		description:
			"Search the signed-in person's **personal** memories (always their personal org, regardless of which org this connection uses). Returned matches are mutable for this person unless can_mutate is false. If you are considering writing or deleting a memory, prefer metaMemoryVerify first. Do not copy a personal memory into an org package without asking the person first.",
		keywords: [
			'memory',
			'search',
			'lookup',
			'related',
			'verify',
			'personal memory',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z.string().min(1).describe('Freeform memory search query.'),
			category: z
				.string()
				.min(1)
				.max(120)
				.optional()
				.describe('Optional category filter. Categories are freeform strings.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(5)
				.describe('Maximum memories to return. Defaults to 5.'),
			include_deleted: z
				.boolean()
				.optional()
				.describe('Whether to include deleted memories. Defaults to false.'),
		}),
		outputSchema: z.object({
			query: z.string(),
			matches: z.array(mutableMemoryMatchSchema),
			warning: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const { auth, scope } = await personalMemoryReadScope(ctx)
			const result = await searchMemoryRecords({
				env: ctx.env,
				userId: auth.userId,
				scope,
				query: args.query,
				category: args.category ?? null,
				limit: args.limit,
				includeDeleted: args.include_deleted ?? false,
			})
			return {
				query: args.query,
				matches: result.matches.map((match) => ({
					id: match.id,
					category: match.category,
					status: match.status,
					subject: match.subject,
					summary: match.summary,
					details: match.details,
					tags: match.tags,
					source_uris: match.sourceUris,
					dedupe_key: match.dedupeKey,
					created_at: match.createdAt,
					updated_at: match.updatedAt,
					last_accessed_at: match.lastAccessedAt,
					deleted_at: match.deletedAt,
					score: match.score,
					can_mutate: true,
					mutation_guidance: memorySearchMutationGuidance,
				})),
				warning: verifyFirstWarning,
			}
		},
	},
)
