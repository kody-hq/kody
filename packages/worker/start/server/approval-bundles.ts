import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'

const bundleInput = z.strictObject({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	bundleId: z.string().trim().min(1),
})

export const loadApprovalBundle = createServerFn({ method: 'GET' })
	.validator(bundleInput)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead, WebsiteAuthenticationError },
			{ loadApprovalViewerForSlug },
			{ loadApprovalBundleView },
			{ setResponseStatus, setResponseHeader },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/approval-bundle-decisions.ts'),
			import('../../src/approval-bundles/service.ts'),
			import('@tanstack/react-start/server'),
		])
		try {
			return await withWebsiteRead({}, async ({ request, env, user }) => {
				const viewer = await loadApprovalViewerForSlug({
					request,
					env,
					user,
					orgSlug: data.orgSlug,
				})
				if (!viewer) throw notFound()
				const result = await loadApprovalBundleView({
					viewer,
					bundleId: data.bundleId,
				})
				setResponseHeader('X-Robots-Tag', 'noindex, nofollow')
				if (!result.ok) {
					if (result.reason === 'not-found') throw notFound()
					setResponseStatus(410)
				}
				return result
			})
		} catch (error) {
			if (error instanceof WebsiteAuthenticationError) {
				const href = `/@${encodeURIComponent(data.orgSlug)}/-/approvals/${encodeURIComponent(data.bundleId)}`
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(href)}`,
				})
			}
			throw error
		}
	})

export const decideApprovalBundle = createServerFn({ method: 'POST' })
	.validator(
		bundleInput.extend({
			action: z.enum(['approve', 'deny']),
			item: z.string().trim().min(1),
			fingerprint: z.string().trim().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ loadApprovalViewerForSlug, decideApprovalBundleItem },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/approval-bundle-decisions.ts'),
		])
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			const viewer = await loadApprovalViewerForSlug({
				request,
				env,
				user,
				orgSlug: data.orgSlug,
			})
			if (!viewer)
				return {
					ok: false as const,
					error: 'Approval bundle not found.',
					item: null,
				}
			const result = await decideApprovalBundleItem({
				viewer,
				request,
				user: { ...user, request: viewer.request },
				bundleId: data.bundleId,
				decision: {
					action: data.action,
					item: data.item,
					fingerprint: data.fingerprint,
				},
			})
			return result.body
		})
	})
