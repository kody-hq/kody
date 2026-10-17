import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const installCommunityPackage = createServerFn({ method: 'POST' })
	.validator(
		z.object({ listingId: z.string().min(1), acknowledged: z.literal(true) }),
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
					body: { acknowledged: data.acknowledged },
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
