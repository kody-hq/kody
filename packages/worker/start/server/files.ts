import type { websiteCapabilityContext as WebsiteCapabilityContext } from '../../src/app/website-capability.ts'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
	fileAccessSchema,
	fileManageSchema,
	fileCreateSchema,
	fileDocumentSchema,
	fileIdSchema,
	fileMetadataSchema,
	fileWriteOutputSchema,
	fileWriteSchema,
} from '#universal/files.ts'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const listSchema = z.object({
	files: z.array(fileMetadataSchema.extend({ access: fileAccessSchema })),
	can_create: z.boolean(),
	writes_enabled: z.boolean(),
})
const getSchema = z.object({
	file: fileDocumentSchema,
	access: fileAccessSchema,
})

async function call(
	input: Parameters<typeof WebsiteCapabilityContext>[0],
	name: string,
	args: Record<string, unknown>,
) {
	const [{ getStaticRegistry }, { callCapabilityAsWebsite }] =
		await Promise.all([
			import('../../src/mcp/capabilities/registry.ts'),
			import('../../src/app/website-capability.ts'),
		])
	const capability = (await getStaticRegistry()).capabilityMap[name]
	if (!capability) throw new Error(`Missing capability ${name}`)
	return callCapabilityAsWebsite(input, capability, args)
}

async function previewFile(
	input: Parameters<typeof call>[0],
	fileId: string,
	revisionId?: string,
) {
	const [
		{ websiteCapabilityContext },
		{ getFileDescriptor },
		{ fileCollaborationEnabled },
	] = await Promise.all([
		import('../../src/app/website-capability.ts'),
		import('../../src/files/service.ts'),
		import('../../src/files/feature.ts'),
	])
	if (!(await fileCollaborationEnabled(input.env, input.user.request)))
		throw notFound()
	const descriptor = await getFileDescriptor(
		websiteCapabilityContext(input),
		fileId,
		revisionId,
	)
	return descriptor.file.encoding === 'base64'
		? descriptor
		: getSchema.parse(
				await call(input, 'fileGet', {
					file_id: fileId,
					revision_id: revisionId,
				}),
			)
}
export const readFilePreview = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			fileId: fileIdSchema,
			revisionId: fileIdSchema.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			(context) => previewFile(context, data.fileId, data.revisionId),
		)
	})
export const loadFilesPage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug, fileId: fileIdSchema.optional() }))
	.handler(async ({ data }) => {
		const [{ loadScopedCollection }, { loadDocumentHead }] = await Promise.all([
			import('./collection-context.ts'),
			import('./document-head.ts'),
		])
		const path = `/@${data.orgSlug}/-/files`
		const {
			bindings: env,
			request,
			user,
		} = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'files',
			returnTo: path + (data.fileId ? `?file=${data.fileId}` : ''),
		})
		const { fileCollaborationEnabled } =
			await import('../../src/files/feature.ts')
		if (!(await fileCollaborationEnabled(env, user.request))) throw notFound()
		const input = { env, request, user }
		const list = listSchema.parse(
			await call(input, 'fileList', { include_trash: true }),
		)
		const selected = data.fileId ? await previewFile(input, data.fileId) : null

		const embeds: z.infer<typeof fileDocumentSchema>[] = []
		return {
			...list,
			canManageStorage: user.request.membership?.role === 'owner',
			personId: user.request.actor?.userId ?? user.mcpUser.userId,
			collaborationEnabled: true,
			files: list.files.filter((file) => !file.trashedAt),
			trashed: list.files.filter((file) => file.trashedAt),
			embeds: embeds.filter((file) => file !== null),
			selected,
			orgSlug: data.orgSlug,
			head: loadDocumentHead('orgFiles', path),
		}
	})

export const saveFile = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			input: z.union([
				fileWriteSchema.extend({
					restore_revision_id: fileIdSchema.optional(),
				}),
				fileCreateSchema,
			]),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) => {
				try {
					let input = data.input
					if ('restore_revision_id' in input && input.restore_revision_id) {
						const source = getSchema.parse(
							await call(context, 'fileGet', {
								file_id: input.file_id,
								revision_id: input.restore_revision_id,
							}),
						)
						const { restore_revision_id: _restore, ...write } = input
						input = { ...write, content: source.file.content }
					}
					const result = fileWriteOutputSchema.parse(
						await call(
							context,
							'name' in input ? 'fileCreate' : 'fileWrite',
							input,
						),
					)
					return result.ok && result.file.encoding === 'base64'
						? { ...result, file: { ...result.file, content: '' } }
						: result
				} catch (error) {
					return {
						ok: false as const,
						code: 'file_error' as const,
						message:
							error instanceof Error
								? error.message
								: 'Could not save. Your draft is still here.',
					}
				}
			},
		)
	})

export const readFileRevision = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			fileId: fileIdSchema,
			revisionId: fileIdSchema.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) =>
				getSchema.parse(
					await call(context, 'fileGet', {
						file_id: data.fileId,
						revision_id: data.revisionId,
					}),
				),
		)
	})

export const shareFile = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			fileId: fileIdSchema,
			email: z.string().email(),
			preset: z.enum(['read', 'contribute', 'manage']),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) => {
				try {
					const result = z.object({ token: z.string() }).parse(
						await call(context, 'inviteCreate', {
							kind: 'grant',
							resource_type: 'file',
							resource_id: data.fileId,
							email: data.email,
							preset: data.preset,
						}),
					)
					return {
						ok: true as const,
						href: `/files/invites/${encodeURIComponent(result.token)}`,
					}
				} catch (error) {
					return {
						ok: false as const,
						message:
							error instanceof Error ? error.message : 'Could not share file.',
					}
				}
			},
		)
	})

export const manageWorkspaceFile = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, input: fileManageSchema }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) => {
				try {
					await call(context, 'fileManage', data.input)
					return { ok: true as const }
				} catch (error) {
					return {
						ok: false as const,
						message:
							error instanceof Error
								? error.message
								: 'Could not update this item.',
					}
				}
			},
		)
	})

export const readFileHistory = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			fileId: fileIdSchema,
			cursor: fileIdSchema.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) =>
				z
					.object({
						revisions: fileMetadataSchema.shape.revisions,
						nextCursor: fileIdSchema.nullable(),
					})
					.parse(
						await call(context, 'fileHistoryGet', {
							file_id: data.fileId,
							cursor: data.cursor,
						}),
					),
		)
	})
