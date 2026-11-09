import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
const scope = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	rootId: fileIdSchema,
	token: z.string().regex(/^[a-f0-9]{64}$/),
	itemId: fileIdSchema.optional(),
})
export const loadPublicFile = createServerFn({ method: 'GET' })
	.validator(scope)
	.handler(async ({ data }) => {
		const [{ getStartRequestEnv }, { publicFileScope }, { setResponseHeader }] =
			await Promise.all([
				import('./request-env.ts'),
				import('../../src/files/public-links.ts'),
				import('@tanstack/react-start/server'),
			])
		setResponseHeader('Cache-Control', 'private, no-store')
		setResponseHeader('Referrer-Policy', 'no-referrer')
		try {
			const result = await publicFileScope(
				getStartRequestEnv(),
				data.orgSlug,
				data.rootId,
				data.token,
				data.itemId,
			)
			const file = result.file
			return {
				ok: true as const,
				file: {
					id: file.id,
					name: file.name,
					mediaType: file.mediaType,
					encoding: file.encoding,
					content: file.encoding === 'base64' ? '' : file.content,
				},
				files: result.files,
			}
		} catch {
			return { ok: false as const }
		}
	})
export const setFilePublicLink = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: scope.shape.orgSlug,
			fileId: fileIdSchema,
			enabled: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ websiteCapabilityContext },
			{ changeFilePublicLink },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/public-links.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			(context) =>
				changeFilePublicLink(
					websiteCapabilityContext(context),
					data.fileId,
					data.enabled,
				),
		)
	})
