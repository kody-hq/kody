import {
	optionalOrgAuditWriter,
	orgAuditCauseFromCaller,
} from '#worker/orgs/org-audit.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	deleteMemory,
	getMemory,
	getMemoryMutationNotFoundMessage,
} from '#mcp/memory/service.ts'
import {
	memoryRecordSchema,
	verifyFirstGuidance,
} from './meta-memory-shared.ts'
import {
	authorizePersonalMemory,
	memoryPersonalOnlyOrgPermission,
} from './meta-memory-owner.ts'

const outputSchema = z.object({
	ok: z.boolean(),
	force: z.boolean(),
	memory: memoryRecordSchema.nullable(),
	guidance: z.string(),
})

export const metaMemoryDeleteCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaMemoryDelete',
		contextRuns: 'allow',
		orgPermission: memoryPersonalOnlyOrgPermission,
		description:
			'Soft-delete a **personal** memory by default, or hard-delete it when `force` is true. Always run `metaMemoryVerify` first. Memory is personal-only; team-org legacy rows cannot be deleted through this tool.',
		keywords: [
			'memory',
			'delete',
			'archive',
			'verify first',
			'soft delete',
			'hard delete',
			'personal memory',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			memory_id: z.string().min(1).describe('Target memory id to delete.'),
			force: z
				.boolean()
				.optional()
				.describe(
					'When true, permanently delete the record. Otherwise soft-delete it by setting status to deleted.',
				),
			verified_by_agent: z
				.boolean()
				.describe(
					'Agent assertion that `metaMemoryVerify` was run before deletion.',
				),
			verification_reference: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional agent-supplied note or reference to the verification step that justified this deletion.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			if (!args.verified_by_agent) {
				throw new Error(
					'Agents must run metaMemoryVerify before calling metaMemoryDelete. Set verified_by_agent=true only after review.',
				)
			}
			const auth = await authorizePersonalMemory(
				ctx,
				'memory:delete',
				args.memory_id,
			)
			const existing = await getMemory({
				env: ctx.env,
				userId: auth.userId,
				memoryId: args.memory_id,
			})
			if (!existing) {
				throw new Error(getMemoryMutationNotFoundMessage(args.memory_id))
			}
			const memory = await deleteMemory({
				env: ctx.env,
				userId: auth.userId,
				memoryId: args.memory_id,
				force: args.force ?? false,
				audit: optionalOrgAuditWriter(
					ctx.env,
					ctx.callerContext.request ?? null,
					orgAuditCauseFromCaller(ctx.callerContext),
				),
			})
			return {
				ok: true,
				force: args.force ?? false,
				memory: formatMemoryRecord(memory),
				guidance: `${verifyFirstGuidance} Use soft delete by default; reserve force=true for records that should be removed permanently.`,
			}
		},
	},
)

function formatMemoryRecord(
	memory:
		| Awaited<ReturnType<typeof deleteMemory>>
		| Awaited<ReturnType<typeof getMemory>>,
) {
	if (!memory) return null
	return {
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
}
