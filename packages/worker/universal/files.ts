import { z } from 'zod'

export const fileByteLimit = 16 * 1024 * 1024
const fileEncodingSchema = z.enum(['utf8', 'base64'])
export const filePayloadSchema = z
	.string()
	.max(4 * Math.ceil(fileByteLimit / 3))
export const fileMediaTypeSchema = z
	.string()
	.max(127)
	.regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i)

export const fileIdSchema = z.string().uuid()
export const fileContentSchema = z
	.string()
	.max(65_536)
	.refine(
		(value) => new TextEncoder().encode(value).byteLength <= 65_536,
		'Text files may contain at most 64 KiB.',
	)
export const fileNameSchema = z.string().trim().min(1).max(200)
const fileRevisionSchema = z.object({
	storageId: fileIdSchema.optional(),
	collaborationBytes: z.number().int().nonnegative().optional(),
	collaborationSha256: z.string().optional(),
	id: fileIdSchema,
	bytes: z.number().int().nonnegative(),
	sha256: z.string(),
	createdAt: z.string(),
	author: z.string(),
})
export const fileMetadataSchema = z.object({
	id: fileIdSchema,
	name: fileNameSchema,
	mediaType: fileMediaTypeSchema,
	encoding: fileEncodingSchema.optional(),
	parentId: fileIdSchema.optional(),
	metadataVersion: z.number().int().nonnegative().optional(),
	collaboration: z.boolean().optional(),
	headVersion: fileIdSchema
		.optional()
		.describe(
			'Live collaboration version. Use this as base_revision_id when present. revisionId and revisions identify immutable checkpoints.',
		),
	headBytes: z.number().int().nonnegative().optional(),
	accessMode: z.enum(['inherit', 'restricted']).optional(),
	trashedAt: z.string().optional(),
	revisionId: fileIdSchema.nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	revisions: z.array(fileRevisionSchema),
	historyCursor: fileIdSchema.nullable().optional(),
	revisionCount: z.number().int().nonnegative().optional(),
})
export type FileMetadata = z.infer<typeof fileMetadataSchema>
export type FileRevision = z.infer<typeof fileRevisionSchema>

export const fileDocumentSchema = fileMetadataSchema.extend({
	content: z.string(),
})
export const fileCreateSchema = z.object({
	file_id: fileIdSchema,
	write_id: fileIdSchema,
	name: fileNameSchema,
	parent_id: fileIdSchema
		.optional()
		.describe(
			'Parent page or directory ID. Omit for the workspace root. Requires read and write access to the parent.',
		),
	media_type: fileMetadataSchema.shape.mediaType.default('text/markdown'),
	content: filePayloadSchema,
	encoding: fileEncodingSchema
		.optional()
		.describe('Use base64 for raw bytes. Defaults to UTF-8 text.'),
})
export const fileWriteSchema = fileCreateSchema
	.pick({ file_id: true, write_id: true, content: true })
	.extend({ base_revision_id: fileIdSchema })
export const fileAccessSchema = z.object({
	comment: z.boolean().optional(),
	write: z.boolean(),
	delete: z.boolean(),
	manage_access: z.boolean(),
})
export const fileWriteOutputSchema = z.union([
	z.object({ ok: z.literal(true), file: fileDocumentSchema }),
	z.object({
		ok: z.literal(false),
		code: z.literal('revision_conflict'),
		current_revision_id: fileIdSchema.nullable(),
		current: z.string(),
		proposed: z.string(),
	}),
])

export const fileManageSchema = z
	.object({
		file_id: fileIdSchema,
		operation_id: fileIdSchema,
		expected_version: z.number().int().nonnegative(),
		action: z.enum(['rename', 'move', 'trash', 'restore', 'access']),
		name: fileNameSchema.optional(),
		parent_id: fileIdSchema.nullable().optional(),
		access_mode: z.enum(['inherit', 'restricted']).optional(),
		access_preview_token: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		if (value.action === 'access' && !value.access_mode)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose an access policy.',
				path: ['access_mode'],
			})
		if (value.action === 'rename' && !value.name)
			ctx.addIssue({ code: 'custom', message: 'Enter a name.', path: ['name'] })
		if (value.action === 'move' && value.parent_id === undefined)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose a destination.',
				path: ['parent_id'],
			})
	})
