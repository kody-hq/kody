import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { routes } from '#universal/routes.ts'
import { repositoryNameMaxLength } from '#universal/repository-create.ts'

const orgSlugSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)

export const loadRepositoryCreatePage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug: orgSlugSchema }))
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadRepositoryCreateOptions },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/handlers/repository-create.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgRepositoryNew.href({ orgSlug: data.orgSlug })
		const { bindings, request, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'repositories',
			returnTo: pathname,
		})
		const payload = await loadRepositoryCreateOptions({
			env: bindings,
			request,
			user,
		})
		return {
			payload,
			head: loadDocumentHead('orgRepositoryNew', pathname),
		}
	})

export const createRepository = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			ownerSlug: orgSlugSchema,
			name: z.string().max(repositoryNameMaxLength * 2),
		}),
	)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { createWebsiteRepository }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/repository-create.ts'),
			])
		return withWebsiteMutation({}, (context) =>
			createWebsiteRepository({ ...context, ...data }),
		)
	})
