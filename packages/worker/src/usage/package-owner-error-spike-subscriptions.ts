import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildPackageOwnerErrorSpikeIdempotencyKey,
	type PackageOwnerErrorSpikeEvent,
} from './package-owner-error-spike-subscription-event.ts'

const packageOwnerErrorSpikeSubscriptionActorTokenId =
	'internal:package-owner-error-spike-subscriptions'

/**
 * Fans `fleet.package_owner_error_spike` to admin-owned packages for audit.
 * Best-effort: the owner email is the primary signal; a missed invoke is
 * logged rather than failing the hourly sweep.
 */
export async function dispatchPackageOwnerErrorSpikeSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: PackageOwnerErrorSpikeEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'package-owner-error-spike',
		buildIdempotencyKey: (savedPackage) =>
			buildPackageOwnerErrorSpikeIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: packageOwnerErrorSpikeSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
