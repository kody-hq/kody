import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import { type loadExecutionContextsScope } from '#app/handlers/execution-contexts.ts'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const segment = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..')
const searchEntries = z.array(z.tuple([z.string(), z.string()])).default([])
const chainEntry = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('context'), id: segment }),
	z.object({ kind: z.literal('cloud') }),
])

export const loadExecutionContextsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			contextId: segment.optional(),
			search: searchEntries,
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadExecutionContextsPageData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/handlers/execution-contexts.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgExecutionContexts.href({
			orgSlug: data.orgSlug,
			rest: data.contextId ?? null,
		})
		const params = new URLSearchParams(data.search)
		const search = params.size ? `?${params}` : ''
		const { bindings, request, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'execution-contexts',
			returnTo: pathname + search,
		})
		const payload = await loadExecutionContextsPageData({
			env: bindings,
			request,
			user,
			orgSlug: data.orgSlug,
			contextId: data.contextId ?? null,
		})
		if ('notFound' in payload) throw notFound()
		return {
			payload,
			head: loadDocumentHead(
				'orgExecutionContexts',
				pathname,
				undefined,
				search,
			),
		}
	})

async function mutate<T>(
	orgSlugValue: string,
	write: (input: {
		env: Env
		request: Request
		user: Parameters<typeof loadExecutionContextsScope>[0]['user']
		orgSlug: string
	}) => Promise<T>,
) {
	const { withWebsiteMutation } = await import('./mutation-context.ts')
	return withWebsiteMutation(
		{ scope: { orgSlug: orgSlugValue, requireMembership: false } },
		({ env, request, user }) =>
			write({ env, request, user, orgSlug: orgSlugValue }),
	)
}

export const optIntoExecutionContext = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, contextId: segment }))
	.handler(async ({ data }) => {
		const { optIntoExecutionContextForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			optIntoExecutionContextForUser({ ...input, contextId: data.contextId }),
		)
	})

export const optOutOfExecutionContext = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, contextId: segment }))
	.handler(async ({ data }) => {
		const { optOutOfExecutionContextForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			optOutOfExecutionContextForUser({ ...input, contextId: data.contextId }),
		)
	})

export const setExecutionChain = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			entries: z.array(chainEntry).max(4),
			strict: z.boolean(),
			ifMatch: z.string().max(200).nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const { setExecutionChainForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			setExecutionChainForUser({
				...input,
				entries: data.entries,
				strict: data.strict,
				ifMatch: data.ifMatch,
			}),
		)
	})

export const loadExecutionContextRuns = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			contextId: segment,
			cursor: z.string().max(500).optional(),
			requester: z.string().max(200).optional(),
			outcome: z.string().max(40).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ withWebsiteRead }, { listExecutionContextRunsForUser }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/execution-contexts.ts'),
			])
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			({ env, request, user }) =>
				listExecutionContextRunsForUser({ env, request, user, ...data }),
		)
	})

export const loadExecutionContextAudit = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug,
			contextId: segment,
			cursor: z.string().max(500).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ withWebsiteRead }, { listExecutionContextAuditForUser }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/execution-contexts.ts'),
			])
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			({ env, request, user }) =>
				listExecutionContextAuditForUser({ env, request, user, ...data }),
		)
	})

export const shareExecutionContext = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			contextId: segment,
			subject: z.discriminatedUnion('kind', [
				z.object({
					kind: z.literal('user'),
					username: z.string().trim().min(1).max(64),
				}),
				z.object({ kind: z.literal('team'), slug: segment }),
				z.object({
					kind: z.literal('org'),
					enabled: z.boolean().optional(),
				}),
			]),
			preset: z.enum(['use', 'contribute', 'manage']),
		}),
	)
	.handler(async ({ data }) => {
		const { setExecutionContextShareForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			setExecutionContextShareForUser({
				...input,
				contextId: data.contextId,
				subject: data.subject,
				preset: data.preset,
			}),
		)
	})

export const removeExecutionContextShare = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, contextId: segment, grantId: segment }))
	.handler(async ({ data }) => {
		const { removeExecutionContextShareForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			removeExecutionContextShareForUser({
				...input,
				contextId: data.contextId,
				grantId: data.grantId,
			}),
		)
	})

export const redirectExecutionContextsEntry = createServerFn({ method: 'GET' })
	.inputValidator((href: string) => {
		if (
			typeof href !== 'string' ||
			!/^\/account\/execution-contexts(?:\?[^#]*)?$/.test(href)
		)
			throw new Error('Invalid execution contexts entry URL.')
		return href
	})
	.handler(async ({ data: href }) => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		const { orgResourcePath } = await import('#universal/org-pages.ts')
		const url = new URL(href, 'https://kody.local')
		try {
			return await withWebsiteRead({}, async ({ user }) => {
				throw redirect({
					href:
						orgResourcePath(user.username, 'execution-contexts') + url.search,
					statusCode: 302,
					headers: { 'Cache-Control': 'private, no-store' },
				})
			})
		} catch (error) {
			if (error instanceof WebsiteAuthenticationError)
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(href)}`,
					statusCode: 302,
					headers: { 'Cache-Control': 'private, no-store' },
				})
			throw error
		}
	})
