import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildFleetUsersAffectedIdempotencyKey,
	type FleetUsersAffectedEvent,
} from './fleet-users-affected-subscription-event.ts'

const fleetUsersAffectedSubscriptionActorTokenId =
	'internal:fleet-users-affected-subscriptions'

/**
 * Fans fleet.users_affected.elevated / .resolved to admin-owned packages.
 * Best-effort: incident state is already persisted in KV.
 */
export async function dispatchFleetUsersAffectedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: FleetUsersAffectedEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'fleet-users-affected',
		buildIdempotencyKey: (savedPackage) =>
			buildFleetUsersAffectedIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: fleetUsersAffectedSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
