import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const installCommunityPackage = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			listingId: z.string().min(1),
			acknowledged: z.literal(true),
			org: z.string().min(1).nullable().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request, user }) => {
			const { installWebsiteCommunityPackage } =
				await import('../../src/app/handlers/community-install.ts')
			return (
				await installWebsiteCommunityPackage({
					env,
					request,
					user,
					listingId: data.listingId,
					body: {
						acknowledged: data.acknowledged,
						...(data.org ? { org: data.org } : {}),
					},
				})
			).data
		})
	})
export const featureCommunityPackage = createServerFn({ method: 'POST' })
	.validator(z.object({ listingId: z.string().min(1), featured: z.boolean() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			const { featureWebsiteCommunityPackage } =
				await import('../../src/app/handlers/community-feature.ts')
			return (
				await featureWebsiteCommunityPackage({
					env,
					request,
					listingId: data.listingId,
					body: { featured: data.featured },
				})
			).data
		})
	})
export const reportCommunityPackage = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			listingId: z.string().min(1),
			reason: z.string().trim().min(1).max(2000),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, user }) => {
			const { reportWebsiteCommunityPackage } =
				await import('../../src/app/handlers/community-detail.ts')
			return (
				await reportWebsiteCommunityPackage({
					env,
					user,
					listingId: data.listingId,
					body: { reason: data.reason },
				})
			).data
		})
	})
export const loadCommunityForkState = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			listingId: z.string().min(1),
			org: z.string().min(1).nullable().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		return withWebsiteRead({}, async ({ env, request, user }) => {
			const { loadWebsiteCommunityForkState } =
				await import('../../src/app/handlers/community-fork-state.ts')
			const { resolveCommunityInstallOwner } =
				await import('../../src/app/community-install-org.ts')
			const owner = await resolveCommunityInstallOwner({
				env,
				request,
				user,
				orgSlug: data.org,
			})
			// The picker only offers orgs that pass; a stale one reads as none.
			if (!owner.ok) return { state: 'none' as const }
			return loadWebsiteCommunityForkState({
				env,
				user,
				listingId: data.listingId,
				ownerId: owner.ownerId,
			})
		}).catch((error: unknown) => {
			// Signed-out viewers have no fork; the button already links to login.
			if (error instanceof WebsiteAuthenticationError)
				return { state: 'none' as const }
			throw error
		})
	})
/**
 * Orgs the viewer may fork a community package into (personal first). Same
 * `package:create` filter as the new-repository owner picker.
 */
export const loadCommunityInstallOrgs = createServerFn({ method: 'GET' })
	.validator(z.object({}).optional())
	.handler(async () => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		return withWebsiteRead({}, async ({ env, request, user }) => {
			const { loadRepositoryCreateOptions } =
				await import('../../src/app/handlers/repository-create.ts')
			const { owners } = await loadRepositoryCreateOptions({
				env,
				request,
				user,
			})
			return { owners }
		}).catch((error: unknown) => {
			if (error instanceof WebsiteAuthenticationError) return { owners: [] }
			throw error
		})
	})
