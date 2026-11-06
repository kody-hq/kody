import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import type { loadExecutionContextsScope } from '#app/handlers/execution-contexts.ts'

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

export const deleteExecutionContext = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, contextId: segment }))
	.handler(async ({ data }) => {
		const { deleteExecutionContextForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			deleteExecutionContextForUser({ ...input, contextId: data.contextId }),
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

export const turnOffExecutionContextCommands = createServerFn({
	method: 'POST',
})
	.validator(z.object({ orgSlug, contextId: segment }))
	.handler(async ({ data }) => {
		const { turnOffExecutionContextCommandsForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			turnOffExecutionContextCommandsForUser({
				...input,
				contextId: data.contextId,
			}),
		)
	})

export const runExecutionContextDaemonAction = createServerFn({
	method: 'POST',
})
	.validator(
		z.object({
			orgSlug,
			contextId: segment,
			action: z.enum(['pause', 'resume', 'restart', 'update', 'logs']),
			reason: z.string().max(200).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { runExecutionContextDaemonActionForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			runExecutionContextDaemonActionForUser({
				...input,
				contextId: data.contextId,
				action: data.action,
				...(data.reason ? { reason: data.reason } : {}),
			}),
		)
	})

export const dismissExecutionContextNotice = createServerFn({
	method: 'POST',
})
	.validator(
		z.object({
			orgSlug,
			contextId: segment,
			fingerprint: z.string().min(1).max(64),
		}),
	)
	.handler(async ({ data }) => {
		const { dismissExecutionContextNoticeForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			dismissExecutionContextNoticeForUser({
				...input,
				contextId: data.contextId,
				fingerprint: data.fingerprint,
			}),
		)
	})

export const previewExecutionContextShare = createServerFn({ method: 'POST' })
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
				z.object({ kind: z.literal('org') }),
			]),
		}),
	)
	.handler(async ({ data }) => {
		const { previewExecutionContextShareForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			previewExecutionContextShareForUser({
				...input,
				contextId: data.contextId,
				subject: data.subject,
			}),
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

export const cancelExecutionContextRun = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, contextId: segment, runId: segment }))
	.handler(async ({ data }) => {
		const { cancelExecutionContextRunForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			cancelExecutionContextRunForUser({
				...input,
				contextId: data.contextId,
				runId: data.runId,
			}),
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
	.validator((href: string) => {
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

const automationTarget = z.object({
	kind: z.enum(['job', 'webhook', 'subscription']),
	jobId: segment.optional(),
	packageId: segment.optional(),
	name: z.string().min(1).max(200).optional(),
})

export const loadAutomationExecution = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug, target: automationTarget }))
	.handler(async ({ data }) => {
		const { getAutomationExecutionForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			getAutomationExecutionForUser({ ...input, target: data.target }),
		)
	})

export const setAutomationExecution = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			target: automationTarget,
			execution: z.record(z.string(), z.unknown()).nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const { setAutomationExecutionForUser } =
			await import('../../src/app/handlers/execution-contexts.ts')
		return mutate(data.orgSlug, (input) =>
			setAutomationExecutionForUser({
				...input,
				target: data.target,
				execution: data.execution,
			}),
		)
	})

/** Desktop setup adds only the caller's own machine to their personal chain. */
export const putDesktopExecutionFirst = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			username: z.string().min(1),
			contextId: segment,
			replaceContextId: segment.optional(),
			// Another org to attach the personal registration to and put first in.
			targetOrgSlug: orgSlug.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{
				attachExecutionContextForUser,
				loadExecutionContextsPageData,
				setExecutionChainForUser,
			},
			{ desktopExecutionChain },
		] = await Promise.all([
			import('../../src/app/handlers/execution-contexts.ts'),
			import('#universal/desktop-execution.ts'),
		])
		return mutate(data.orgSlug, async (input) => {
			if (input.user.username !== data.username)
				throw new Error('Your account changed. Start machine setup again.')
			const page = await loadExecutionContextsPageData({
				...input,
				contextId: null,
			})
			if ('notFound' in page || !page.enabled || !page.personalOrg)
				throw new Error('Set up this machine in your personal workspace.')
			const context = page.contexts.find((item) => item.id === data.contextId)
			if (
				!context ||
				context.operator.handle !== data.username ||
				context.ownerOrg.slug !== data.orgSlug ||
				context.status === 'revoked'
			)
				throw new Error('This machine is not registered to your account.')
			let chainOrg = input
			let chain = page.chain
			if (data.targetOrgSlug && data.targetOrgSlug !== data.orgSlug) {
				chainOrg = { ...input, orgSlug: data.targetOrgSlug }
				const target = await loadExecutionContextsPageData({
					...chainOrg,
					contextId: null,
				})
				if ('notFound' in target || !target.enabled || target.personalOrg)
					throw new Error(
						`Execution contexts are not available in @${data.targetOrgSlug}.`,
					)
				const attached = await attachExecutionContextForUser({
					...input,
					contextId: data.contextId,
					targetOrgSlug: data.targetOrgSlug,
				})
				if (!attached.ok) throw new Error(attached.message)
				chain = target.chain
			}
			const result = await setExecutionChainForUser({
				...chainOrg,
				...desktopExecutionChain(chain, data.contextId, data.replaceContextId),
				ifMatch: chain.updatedAt,
			})
			if (!result.ok) throw new Error(result.message)
			return result
		})
	})
