import {
	optionalOrgAuditWriter,
	orgAuditCauseFromCaller,
} from '#worker/orgs/org-audit.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { upsertMemory } from '#mcp/memory/service.ts'
import {
	memoryDetailsField,
	memoryRecordSchema,
	memorySourceUrisField,
	memorySubjectField,
	memorySummaryField,
	memoryTagsField,
} from '#mcp/capabilities/meta/meta-memory-shared.ts'
import {
	authorizePersonalMemory,
	memoryPersonalOnlyOrgPermission,
} from './meta-memory-owner.ts'

const inputSchema = z.object({
	memory_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional existing memory id to update. Omit this field to create a new memory record.',
		),
	category: z
		.string()
		.max(80)
		.optional()
		.describe(
			'Optional freeform category string. Suggested examples include preference, profile, workflow, relationship, or identifier.',
		),
	subject: memorySubjectField,
	summary: memorySummaryField,
	details: memoryDetailsField,
	tags: memoryTagsField,
	source_uris: memorySourceUrisField,
	dedupe_key: z
		.string()
		.max(160)
		.optional()
		.describe('Optional stable dedupe key supplied by the agent.'),
	status: z
		.enum(['active', 'archived'])
		.optional()
		.describe(
			'Optional non-deleted status for the memory. Defaults to active.',
		),
	verified_by_agent: z
		.boolean()
		.describe(
			'Must be true when writing memory. Agents must run metaMemoryVerify first and then decide whether to upsert.',
		),
	verification_reference: z
		.string()
		.max(200)
		.optional()
		.describe(
			'Optional agent-supplied note, run id, or verification reference describing the verify step that preceded this upsert.',
		),
})

const outputSchema = z.object({
	mode: z.enum(['created', 'updated']),
	memory: memoryRecordSchema,
	warnings: z.array(z.string()),
})

export const metaMemoryUpsertCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaMemoryUpsert',
		contextRuns: 'allow',
		orgPermission: memoryPersonalOnlyOrgPermission,
		description:
			'Create or update a **personal** memory for the signed-in person (always their personal org, regardless of which org this connection uses). Agents must run `metaMemoryVerify` first. Do not blindly write durable memory without verification. Do not copy a personal memory into an org package without asking the person first. Shared org knowledge belongs in documented packages and org instructions, not memory. If the candidate is really package- or export-scoped guidance, update package docs or JSDoc instead (see search({ entity: "guide:agent_guidance" })).',
		keywords: [
			'memory',
			'upsert',
			'create',
			'update',
			'verify-first',
			'long-term memory',
			'personal memory',
			'agent guidance',
			'package docs',
			'jsdoc',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			if (!args.verified_by_agent) {
				throw new Error(
					'Agents must run metaMemoryVerify before calling metaMemoryUpsert. Set verified_by_agent=true only after review.',
				)
			}
			const auth = args.memory_id
				? await authorizePersonalMemory(ctx, 'memory:write', args.memory_id)
				: await authorizePersonalMemory(ctx, 'memory:create')
			const result = await upsertMemory({
				env: ctx.env,
				userId: auth.userId,
				userEmail: auth.email,
				memoryId: args.memory_id ?? null,
				category: args.category ?? null,
				subject: args.subject,
				summary: args.summary,
				details: args.details ?? '',
				tags: args.tags ?? [],
				sourceUris: args.source_uris ?? [],
				dedupeKey: args.dedupe_key ?? null,
				status: args.status ?? 'active',
				verificationReference: args.verification_reference ?? null,
				audit: optionalOrgAuditWriter(
					ctx.env,
					ctx.callerContext.request ?? null,
					orgAuditCauseFromCaller(ctx.callerContext),
				),
			})
			return {
				mode: result.mode,
				memory: {
					id: result.memory.id,
					category: result.memory.category,
					status: result.memory.status,
					subject: result.memory.subject,
					summary: result.memory.summary,
					details: result.memory.details,
					tags: result.memory.tags,
					source_uris: result.memory.sourceUris,
					dedupe_key: result.memory.dedupeKey,
					created_at: result.memory.createdAt,
					updated_at: result.memory.updatedAt,
					last_accessed_at: result.memory.lastAccessedAt,
					deleted_at: result.memory.deletedAt,
				},
				warnings: result.warnings,
			}
		},
	},
)
