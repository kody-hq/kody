import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import {
	approvalBundleMaxItems,
	type ApprovalBundleApproveAllEvent,
} from '#universal/approval-bundles.ts'

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
				if ('href' in result) throw redirect({ href: result.href })
				setResponseHeader('X-Robots-Tag', 'noindex, nofollow')
				if (!result.ok) {
					setResponseStatus(result.reason === 'expired' ? 410 : 404)
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

/** Buffers events so the batch never waits on a slow or closed reader. */
function eventChannel<T>() {
	const buffered: Array<T> = []
	let closed = false
	let wake: (() => void) | null = null
	const notify = () => {
		wake?.()
		wake = null
	}
	return {
		push(value: T) {
			if (closed) return
			buffered.push(value)
			notify()
		},
		close() {
			closed = true
			notify()
		},
		async *values(): AsyncGenerator<T, void, unknown> {
			for (;;) {
				if (buffered.length > 0) {
					yield buffered.shift()!
					continue
				}
				if (closed) return
				await new Promise<void>((resolve) => {
					wake = resolve
				})
			}
		},
	}
}

/**
 * Approve all in one request. Items stream back as each starts and finishes.
 * The batch runs under `waitUntil`, so closing the tab does not cancel the
 * approvals already running.
 */
export const approveAllApprovalBundle = createServerFn({ method: 'POST' })
	.validator(
		bundleInput.extend({
			items: z
				.array(
					z.strictObject({
						item: z.string().trim().min(1),
						fingerprint: z.string().trim().min(1),
					}),
				)
				.min(1)
				.max(approvalBundleMaxItems),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ loadApprovalViewerForSlug, approveApprovalBundleItems },
			{ waitUntil },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/approval-bundle-decisions.ts'),
			import('cloudflare:workers'),
		])
		const events = eventChannel<ApprovalBundleApproveAllEvent>()
		let started: (found: boolean) => void = () => {}
		let failedToStart: (error: unknown) => void = () => {}
		const ready = new Promise<boolean>((resolve, reject) => {
			started = resolve
			failedToStart = reject
		})
		const run = withWebsiteMutation({}, async ({ request, env, user }) => {
			const viewer = await loadApprovalViewerForSlug({
				request,
				env,
				user,
				orgSlug: data.orgSlug,
			})
			started(viewer !== null)
			if (!viewer) return
			await approveApprovalBundleItems({
				viewer,
				request,
				user: { ...user, request: viewer.request },
				bundleId: data.bundleId,
				items: data.items,
				onEvent: events.push,
			})
		}).then(
			() => events.close(),
			(error: unknown) => {
				failedToStart(error)
				events.close()
				console.error('Approve all failed:', {
					bundleId: data.bundleId,
					error,
				})
			},
		)
		waitUntil(run)
		if (!(await ready))
			return { ok: false as const, error: 'Approval bundle not found.' }
		return { ok: true as const, events: events.values() }
	})
