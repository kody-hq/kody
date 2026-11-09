import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
const source = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	rootId: fileIdSchema,
	token: z.string().regex(/^[a-f0-9]{64}$/),
	itemId: fileIdSchema,
})

export const preparePublicFileCopy = createServerFn({ method: 'POST' })
	.validator(source)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ loadOrgBindingForPerson },
			{ deriveRequestContext },
			{ websiteCapabilityContext },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/orgs/repo.ts'),
			import('../../src/request-context/request-context.ts'),
			import('../../src/app/website-capability.ts'),
		])
		return withWebsiteMutation({}, async (context) => {
			const binding = await loadOrgBindingForPerson(
				context.env.APP_DB,
				context.user.mcpUser.userId,
			)
			const scoped = deriveRequestContext({
				user: context.user.mcpUser,
				source: { kind: 'session' },
				orgBinding: binding,
			})
			const { prepareSharedCopy } =
				await import('../../src/files/shared-copy-service.ts')
			return prepareSharedCopy(
				websiteCapabilityContext({
					...context,
					user: { ...context.user, request: scoped },
				}),
				data,
			)
		})
	})

export const copyPublicFileStep = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			ticket: z.string().max(200_000),
			index: z.number().int().min(0).max(127),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ loadOrgBindingForPerson },
			{ deriveRequestContext },
			{ websiteCapabilityContext },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/orgs/repo.ts'),
			import('../../src/request-context/request-context.ts'),
			import('../../src/app/website-capability.ts'),
		])
		return withWebsiteMutation({}, async (context) => {
			const binding = await loadOrgBindingForPerson(
				context.env.APP_DB,
				context.user.mcpUser.userId,
			)
			const request = deriveRequestContext({
				user: context.user.mcpUser,
				source: { kind: 'session' },
				orgBinding: binding,
			})
			const { copySharedItem } =
				await import('../../src/files/shared-copy-service.ts')
			return copySharedItem(
				websiteCapabilityContext({
					...context,
					user: { ...context.user, request: request },
				}),
				data,
			)
		})
	})
