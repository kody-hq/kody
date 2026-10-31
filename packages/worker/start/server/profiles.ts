import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import { type loadProfilesPageData } from '#app/handlers/profiles.ts'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const id = z.string().min(1).max(200)
const isoTime = z.string().datetime({ offset: true })
const grant = z.object({
	resourceType: z.string().min(1).max(64),
	resourceId: id,
	permissions: z.array(z.string().min(1).max(64)).min(1).max(64),
})

export const loadProfilesPage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug, members: z.enum(['all']).optional() }))
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadProfilesPageData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/handlers/profiles.ts'),
			import('./document-head.ts'),
		])
		const pathname = routes.orgProfiles.href({ orgSlug: data.orgSlug })
		const search = data.members ? `?members=${data.members}` : ''
		const { bindings, request, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'profiles',
			returnTo: pathname + search,
		})
		const payload = await loadProfilesPageData({
			env: bindings,
			request,
			user,
			orgSlug: data.orgSlug,
			allMembers: data.members === 'all',
		})
		if ('notFound' in payload) throw notFound()
		return {
			payload,
			head: loadDocumentHead('orgProfiles', pathname, undefined, search),
		}
	})

async function mutate<T>(
	orgSlugValue: string,
	write: (input: {
		env: Env
		request: Request
		user: Parameters<typeof loadProfilesPageData>[0]['user']
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

export const createProfile = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			name: z.string().min(1).max(63),
			parentProfileId: id.nullable(),
			expiresAt: isoTime.nullable(),
			grants: z.array(grant).max(50),
		}),
	)
	.handler(async ({ data }) => {
		const { createProfileForUser } =
			await import('../../src/app/handlers/profiles.ts')
		return mutate(data.orgSlug, (input) =>
			createProfileForUser({
				...input,
				name: data.name,
				parentProfileId: data.parentProfileId,
				expiresAt: data.expiresAt,
				grants: data.grants,
			}),
		)
	})

export const shortenProfileExpiry = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, profileId: id, expiresAt: isoTime }))
	.handler(async ({ data }) => {
		const { shortenProfileExpiryForUser } =
			await import('../../src/app/handlers/profiles.ts')
		return mutate(data.orgSlug, (input) =>
			shortenProfileExpiryForUser({
				...input,
				profileId: data.profileId,
				expiresAt: data.expiresAt,
			}),
		)
	})

export const revokeProfile = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, profileId: id }))
	.handler(async ({ data }) => {
		const { revokeProfileForUser } =
			await import('../../src/app/handlers/profiles.ts')
		return mutate(data.orgSlug, (input) =>
			revokeProfileForUser({ ...input, profileId: data.profileId }),
		)
	})

export const createProfileToken = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			profileId: id,
			name: z.string().min(1).max(100),
			scopes: z.array(z.string().min(1).max(64)).min(1).max(64),
			lifetime: z.enum(['short', 'long']),
		}),
	)
	.handler(async ({ data }) => {
		const { createProfileTokenForUser } =
			await import('../../src/app/handlers/profiles.ts')
		return mutate(data.orgSlug, (input) =>
			createProfileTokenForUser({
				...input,
				profileId: data.profileId,
				name: data.name,
				scopes: data.scopes,
				lifetime: data.lifetime,
			}),
		)
	})

export const revokeProfileToken = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, tokenId: id }))
	.handler(async ({ data }) => {
		const { revokeProfileTokenForUser } =
			await import('../../src/app/handlers/profiles.ts')
		return mutate(data.orgSlug, (input) =>
			revokeProfileTokenForUser({ ...input, tokenId: data.tokenId }),
		)
	})

export const redirectProfilesEntry = createServerFn({ method: 'GET' })
	.validator((href: string) => {
		if (
			typeof href !== 'string' ||
			!/^\/account\/profiles(?:\?[^#]*)?$/.test(href)
		)
			throw new Error('Invalid profiles entry URL.')
		return href
	})
	.handler(async ({ data: href }) => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		const { orgResourcePath } = await import('#universal/org-pages.ts')
		const { personalUsageSlug } = await import('#app/handlers/account-usage.ts')
		const url = new URL(href, 'https://kody.local')
		try {
			return await withWebsiteRead({}, async ({ user, env }) => {
				const slug = await personalUsageSlug(env, user)
				throw redirect({
					href: orgResourcePath(slug, 'profiles') + url.search,
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
