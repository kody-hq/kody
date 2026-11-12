import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
import {
	commentCommandSchema,
	roomSnapshotSchema,
	threadSchema,
	commentSchema,
	threadCommentPageSchema,
} from '#universal/file-collaboration.ts'
const scope = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	fileId: fileIdSchema,
})
const commentResult = z.object({
	sequence: z.number(),
	replayed: z.boolean(),
	threads: z.array(threadSchema),
	comments: z.array(commentSchema),
	nextCursor: z.string().nullable(),
	commentCursors: z.record(z.string(), z.string().nullable()),
})
export const readFileCollaboration = createServerFn({ method: 'GET' })
	.validator(scope.extend({ cursor: z.string().optional() }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead },
			{ websiteCapabilityContext },
			{ getFileCollaboration },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/service.ts'),
		])
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) =>
				roomSnapshotSchema.parse(
					await getFileCollaboration(
						websiteCapabilityContext(context),
						data.fileId,
						data.cursor,
					),
				),
		)
	})
export const sendFileComment = createServerFn({ method: 'POST' })
	.validator(scope.extend({ command: commentCommandSchema }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ websiteCapabilityContext },
			{ commentOnFile },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/service.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) =>
				commentResult.parse(
					await commentOnFile(
						websiteCapabilityContext(context),
						data.fileId,
						data.command,
					),
				),
		)
	})
export const readFileMovePreview = createServerFn({ method: 'GET' })
	.validator(scope.extend({ parentId: fileIdSchema.nullable() }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead },
			{ websiteCapabilityContext },
			{ previewFileMove },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/service.ts'),
		])
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			(context) =>
				previewFileMove(
					websiteCapabilityContext(context),
					data.fileId,
					data.parentId,
				),
		)
	})

export const readFileThreadComments = createServerFn({ method: 'GET' })
	.validator(
		scope.extend({
			threadId: fileIdSchema,
			cursor: z.string().max(300).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead },
			{ websiteCapabilityContext },
			{ getFileThreadComments },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/service.ts'),
		])
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) =>
				threadCommentPageSchema.parse(
					await getFileThreadComments(
						websiteCapabilityContext(context),
						data.fileId,
						data.threadId,
						data.cursor,
					),
				),
		)
	})
