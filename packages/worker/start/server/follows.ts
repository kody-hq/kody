import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type FollowOperationResult } from '#universal/follows.ts'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const target = z.object({
	name: z.string().trim().min(1),
	kind: z.enum(['package', 'repo']),
})
const orgInput = z.object({ orgSlug })

export const loadOrgFollows = createServerFn({ method: 'GET' })
	.inputValidator(orgInput)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ resolveOrgManagementAccess },
			{ loadOrgFollowsData },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('#app/org-management-access.ts'),
			import('#app/follows-web.ts'),
		])
		const context = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'follows',
			returnTo: `/@${encodeURIComponent(data.orgSlug)}/-/follows`,
		})
		const access = await resolveOrgManagementAccess({
			env: context.bindings,
			request: context.request,
			user: context.user,
			orgSlug: data.orgSlug,
			permission: 'org:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			throw new Error(access.error)
		}
		return loadOrgFollowsData({ env: context.bindings, org: access.org })
	})

export const loadPackageFollow = createServerFn({ method: 'GET' })
	.inputValidator(
		z.object({
			username: z.string().trim().min(1),
			kodyId: z.string().trim().min(1),
			kind: z.enum(['package', 'repo']).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead, WebsiteAuthenticationError },
			{ loadPackageFollowState },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('#app/follows-web.ts'),
		])
		return withWebsiteRead({}, async ({ env, user }) => {
			const result = await loadPackageFollowState({
				env,
				user,
				...data,
				kind: data.kind,
			})
			if (!result) throw notFound()
			return result
		}).catch((error: unknown) => {
			if (error instanceof WebsiteAuthenticationError) {
				const redirectTo = `/@${encodeURIComponent(data.username)}/${encodeURIComponent(data.kodyId)}#follow`
				throw redirect({
					href: `/login?${new URLSearchParams({ redirectTo })}`,
				})
			}
			throw error
		})
	})

async function write(
	orgSlug: string,
	operation: (context: {
		env: Env
		user: AuthenticatedAppUser
		org: { id: string }
	}) => Promise<FollowOperationResult>,
) {
	const [
		{ withWebsiteMutation },
		{ resolveOrgManagementAccess },
		{ followOperationStatus },
		{ setResponseStatus },
	] = await Promise.all([
		import('./mutation-context.ts'),
		import('#app/org-management-access.ts'),
		import('#app/follows-web.ts'),
		import('@tanstack/react-start/server'),
	])
	return withWebsiteMutation({ scope: { orgSlug } }, async (context) => {
		const access = await resolveOrgManagementAccess({
			...context,
			orgSlug,
			permission: 'org:read',
		})
		if (!access.ok) {
			setResponseStatus(access.status)
			throw new Error(access.error)
		}
		const result = await operation({ ...context, org: access.org })
		if (!result.ok) {
			setResponseStatus(followOperationStatus(result))
			throw new Error(result.error)
		}
		return result
	})
}

export const followTarget = createServerFn({ method: 'POST' })
	.inputValidator(
		target.extend({
			orgSlug,
			events: z.array(z.enum(['published', 'pushed'])).optional(),
		}),
	)
	.handler(({ data: { orgSlug, ...data } }) =>
		write(orgSlug, async (context) =>
			(await import('#app/follows-web.ts')).followOrgTarget({
				...context,
				...data,
			}),
		),
	)

export const resumeFollow = createServerFn({ method: 'POST' })
	.inputValidator(orgInput.extend({ id: z.string().trim().min(1) }))
	.handler(({ data }) =>
		write(data.orgSlug, async (context) =>
			(await import('#app/follows-web.ts')).resumeOrgFollow({
				...context,
				id: data.id,
			}),
		),
	)

export const unfollowTarget = createServerFn({ method: 'POST' })
	.inputValidator(
		z.union([
			orgInput.extend({ id: z.string().trim().min(1) }),
			target.extend({ orgSlug }),
		]),
	)
	.handler(({ data: { orgSlug, ...data } }) =>
		write(orgSlug, async (context) =>
			(await import('#app/follows-web.ts')).unfollowOrgTarget({
				...context,
				...data,
			}),
		),
	)
