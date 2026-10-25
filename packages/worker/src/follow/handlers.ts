import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listEnablementsForInstance } from '#worker/enablements/repo.ts'
import { loadMatchingPackageSubscriptions } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import {
	describeFollowRecentUpdate,
	followEventCopy,
	followEvents,
	type FollowEvent,
	type FollowRecentUpdate,
} from '#universal/follows.ts'
import { type FollowRecentUpdateRecord } from './types.ts'

/**
 * Follow events no package subscription in the org handles with an `on`
 * enablement, so delivery stores them as Recent updates instead. Filters are
 * not evaluated, so a filtered handler still counts as handling the topic.
 * A failed or incomplete discovery reports nothing as unhandled rather than
 * guessing.
 */
export async function loadUnhandledFollowEvents(input: {
	env: Env
	orgId: string
}): Promise<Array<FollowEvent>> {
	try {
		const baseUrl = getAppBaseUrl({ env: input.env })
		const unhandled: Array<FollowEvent> = []
		for (const event of followEvents) {
			const topic = followEventCopy[event].topic
			const { subscriptions, discoveryErrors } =
				await loadMatchingPackageSubscriptions({
					env: input.env,
					baseUrl,
					userId: input.orgId,
					topic,
				})
			if (discoveryErrors.length > 0) return []
			let handled = false
			for (const { savedPackage } of subscriptions) {
				const enablements = await listEnablementsForInstance({
					db: input.env.APP_DB,
					orgId: savedPackage.userId,
					triggerKind: 'subscription',
					instanceId: savedPackage.id,
					triggerName: topic,
				})
				if (enablements.some((enablement) => enablement.state === 'on')) {
					handled = true
					break
				}
			}
			if (!handled) unhandled.push(event)
		}
		return unhandled
	} catch (error) {
		console.error('follow-handler-discovery-failed', {
			orgId: input.orgId,
			error,
		})
		return []
	}
}

export function followRecentUpdateView(
	record: FollowRecentUpdateRecord,
): FollowRecentUpdate {
	return {
		id: record.id,
		name: record.targetName,
		kind: record.targetKind,
		href: getCommunityPackageHrefFromName(record.targetName),
		event: record.detail.event,
		occurredAt: record.occurredAt,
		summary: describeFollowRecentUpdate(record.detail),
	}
}
