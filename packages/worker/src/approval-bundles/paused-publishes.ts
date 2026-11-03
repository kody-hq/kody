import * as Sentry from '@sentry/cloudflare'
import type { ApprovalViewer } from './item-views.ts'
import { createApprovalBundle, listPendingApprovalItems } from './service.ts'

export type PausedPublishBundle = { url: string; count: number }

/**
 * When a publish pauses for approval and other paused publishes already wait
 * on the same person, bundles them so one page approves them all. Null when
 * this is the only one, or on any failure: a bundle link is a convenience and
 * never changes the publish result.
 */
export async function bundlePausedPublishes(input: {
	viewer: ApprovalViewer | null
	/** The org that owns the paused package; bundles stay inside one org. */
	ownerUserId: string
}): Promise<PausedPublishBundle | null> {
	const { viewer } = input
	if (!viewer?.request.actor || !viewer.request.org.slug) return null
	if (viewer.request.org.id !== input.ownerUserId) return null
	try {
		const pending = await listPendingApprovalItems(viewer, {
			types: ['publish'],
		})
		if (pending.length < 2) return null
		const created = await createApprovalBundle({
			viewer,
			filter: { types: ['publish'] },
			note: null,
		})
		return { url: created.url, count: created.items.length }
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: 'approval-bundles.paused-publishes' },
		})
		return null
	}
}

export function pausedPublishBundleMessage(bundle: PausedPublishBundle | null) {
	return bundle
		? `${bundle.count} paused publishes wait for approval, including this one. The person you act for can approve them together at ${bundle.url} (only they can open it).`
		: null
}
