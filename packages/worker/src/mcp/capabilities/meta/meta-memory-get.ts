import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getMemory } from '#mcp/memory/service.ts'
import { memoryRecordSchema } from './meta-memory-shared.ts'
import {
	authorizePersonalMemory,
	memoryPersonalOnlyOrgPermission,
} from './meta-memory-owner.ts'

export const metaMemoryGetCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaMemoryGet',
		contextRuns: 'allow',
		orgPermission: memoryPersonalOnlyOrgPermission,
		description:
			'Load one stored **personal** memory by id for the signed-in person (always their personal org, regardless of which org this connection uses).',
		keywords: [
			'memory',
			'get',
			'load',
			'read',
			'durable memory',
			'personal memory',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			memory_id: z.string().min(1).describe('Stored memory id to load.'),
		}),
		outputSchema: memoryRecordSchema.nullable(),
		async handler(args, ctx: CapabilityContext) {
			const auth = await authorizePersonalMemory(
				ctx,
				'memory:read',
				args.memory_id,
			)
			const memory = await getMemory({
				env: ctx.env,
				userId: auth.userId,
				memoryId: args.memory_id,
			})
			return memory
				? {
						id: memory.id,
						category: memory.category,
						status: memory.status,
						subject: memory.subject,
						summary: memory.summary,
						details: memory.details,
						tags: memory.tags,
						source_uris: memory.sourceUris,
						dedupe_key: memory.dedupeKey,
						created_at: memory.createdAt,
						updated_at: memory.updatedAt,
						last_accessed_at: memory.lastAccessedAt,
						deleted_at: memory.deletedAt,
					}
				: null
		},
	},
)
