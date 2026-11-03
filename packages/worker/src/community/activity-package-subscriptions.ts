import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildCommunityActivityRecordedEvent,
	communityActivityRecordedTopic,
} from './activity-subscription-event.ts'
import { CommunityActivityDispatchCancelledError } from './errors.ts'
import { getCommunityActivityForAdmin } from './service.ts'
import type { CommunityActivityKind } from './types.ts'

const communityActivitySubscriptionActorTokenId =
	'internal:community-activity-subscriptions'

export async function dispatchCommunityActivityRecordedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	eventId: string
	kind: CommunityActivityKind
	activityId: string
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: communityActivityRecordedTopic,
		getParams: async () => {
			const activity = await getCommunityActivityForAdmin({
				db: input.env.APP_DB,
				kind: input.kind,
				activityId: input.activityId,
			})
			if (!activity) {
				throw new CommunityActivityDispatchCancelledError({
					kind: input.kind,
					activityId: input.activityId,
				})
			}
			return buildCommunityActivityRecordedEvent({
				eventId: input.eventId,
				activity,
			}) as Record<string, unknown>
		},
		source: 'community-activity',
		buildIdempotencyKey: (savedPackage) =>
			`community-activity:${input.eventId}:${savedPackage.id}:${communityActivityRecordedTopic}`,
		actorTokenId: communityActivitySubscriptionActorTokenId,
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
	})
}
