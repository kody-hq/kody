import { z } from 'zod'
import { memoryStatusValues } from '#mcp/memory/types.ts'

/** Keep these in sync with `.max(...)` on the shared memory field schemas. */
export const memorySubjectMaxLength = 200
export const memorySummaryMaxLength = 500
export const memoryDetailsMaxLength = 2_000

export const memoryCategoryField = z
	.string()
	.min(1)
	.max(80)
	.optional()
	.describe(
		'Optional freeform category label for the memory. Suggested examples: preference, identifier, relationship, workflow, project, profile.',
	)

const maxSourceUriLength = 2_048
const maxSourceUriCount = 12

export const memoryTagInputSchema = z.string().min(1).max(80)
export const memorySourceUriSchema = z.string().url().max(maxSourceUriLength)

export const memoryTagsField = z
	.array(memoryTagInputSchema)
	.max(12)
	.optional()
	.describe('Optional short tags for retrieval and filtering.')

export const memorySourceUrisField = z
	.array(memorySourceUriSchema)
	.max(maxSourceUriCount)
	.optional()
	.describe(
		'Optional canonical source document URLs for the memory. Treat these as opaque references.',
	)

function stringTooLongMessage(field: string, maxLength: number) {
	return (issue: {
		input: { length: number } | undefined
		maximum: number | bigint
	}) => {
		const maximum =
			typeof issue.maximum === 'bigint' ? Number(issue.maximum) : issue.maximum
		const limit = Number.isFinite(maximum) ? maximum : maxLength
		const actualLength = issue.input?.length
		if (actualLength === undefined) {
			return `${field} must be at most ${String(limit)} characters`
		}
		return `${field} must be at most ${String(limit)} characters, got ${String(actualLength)}`
	}
}

export const memorySubjectField = z
	.string()
	.min(1)
	.max(memorySubjectMaxLength, {
		error: stringTooLongMessage('subject', memorySubjectMaxLength),
	})
	.describe(
		`Short durable subject line for the memory record (max ${String(memorySubjectMaxLength)} characters).`,
	)

export const memorySummaryField = z
	.string()
	.min(1)
	.max(memorySummaryMaxLength, {
		error: stringTooLongMessage('summary', memorySummaryMaxLength),
	})
	.describe(
		`Compact durable summary of the memory (max ${String(memorySummaryMaxLength)} characters).`,
	)

export const memoryDetailsField = z
	.string()
	.max(memoryDetailsMaxLength, {
		error: stringTooLongMessage('details', memoryDetailsMaxLength),
	})
	.optional()
	.describe(
		`Optional supporting details for the durable memory record (max ${String(memoryDetailsMaxLength)} characters).`,
	)

export const memoryBaseInputSchema = {
	subject: memorySubjectField,
	summary: memorySummaryField,
	details: memoryDetailsField,
	category: memoryCategoryField,
	tags: memoryTagsField,
	source_uris: memorySourceUrisField,
	dedupe_key: z
		.string()
		.min(1)
		.max(160)
		.optional()
		.describe(
			'Optional stable agent-supplied dedupe key for the memory. Reuse when the agent wants a deterministic durable key.',
		),
} as const

export const verifyCandidateInputSchema = z.object(memoryBaseInputSchema)

export const memoryVerifyInputSchema = verifyCandidateInputSchema.extend({
	limit: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe('Maximum related memories to return. Defaults to 5.'),
	conversation_id: z
		.string()
		.min(1)
		.max(64)
		.optional()
		.describe(
			'Optional conversation id used to suppress memories that were already surfaced in the same conversation.',
		),
	include_suppressed_in_conversation: z
		.boolean()
		.optional()
		.describe(
			'When true, include memories even if they were already surfaced for the same conversation id.',
		),
})

export const memoryRecordSchema = z.object({
	id: z.string(),
	category: z.string().nullable(),
	status: z.enum(memoryStatusValues),
	subject: z.string(),
	summary: z.string(),
	details: z.string(),
	tags: z.array(z.string()),
	source_uris: z.array(memorySourceUriSchema).optional(),
	dedupe_key: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	last_accessed_at: z.string().nullable(),
	deleted_at: z.string().nullable(),
})

export const memoryMatchSchema = memoryRecordSchema.extend({
	score: z.number(),
})

export const verifyFirstGuidance =
	'Always run metaMemoryVerify before upserting or deleting memories. Review the related memories returned by verify, then decide whether to upsert, delete, both, or do nothing. Do not mutate memory blindly.'

export const verifyFirstWarning =
	'If you are considering writing or deleting memory, run metaMemoryVerify first and review related memories before taking action.'
