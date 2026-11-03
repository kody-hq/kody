import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AdminPackageSubscriptions from '#worker/package-invocations/admin-package-subscriptions.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildFleetEntitlementCrossingIdempotencyKey,
	buildFleetEntitlementResourceCrossedEvent,
	fleetEntitlementCrossedTopic,
} from './fleet-entitlement-crossing-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent:
		vi.fn<
			typeof AdminPackageSubscriptions.dispatchAdminPackageSubscriptionEvent
		>(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchFleetEntitlementCrossingSubscriptionEvent } =
	await import('./fleet-entitlement-crossing-subscriptions.ts')

const adminSavedPackage: SavedPackageRecord = {
	id: 'package-1',
	userId: ownerIdFromStored('admin-user-1'),
	name: 'Admin package',
	kodyId: 'admin-package',
	description: '',
	tags: [],
	searchText: null,
	sourceId: 'source-1',
	hasApp: false,
	hasSkills: false,
	hidden: false,
	isPrivate: false,
	isInternetVisible: false,
	lockedAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
}

test('fleet entitlement crossing dispatch fans metadata-only events through admin package fan-out', async () => {
	const event = buildFleetEntitlementResourceCrossedEvent({
		user: { id: 'user-1', username: 'maciek' },
		resource: 'saved_packages',
		label: 'saved packages',
		threshold: 'reached',
		current: 10,
		limit: 10,
		percentOfLimit: 1,
		insightsUrl: 'https://kody.codes/admin/insights',
		usersUrl: 'https://kody.codes/admin/users',
		observedAt: '2026-08-24T16:00:18.000Z',
	})

	const dispatched: Array<{
		params: Record<string, unknown>
		idempotencyKey: string
		input: Parameters<
			typeof AdminPackageSubscriptions.dispatchAdminPackageSubscriptionEvent
		>[0]
	}> = []
	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input) => {
			dispatched.push({
				params: await input.getParams(),
				idempotencyKey: input.buildIdempotencyKey(adminSavedPackage),
				input,
			})
			return []
		},
	)

	await dispatchFleetEntitlementCrossingSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://kody.codes',
		},
		event,
	})

	expect(dispatched[0]).toMatchObject({
		params: event,
		idempotencyKey: buildFleetEntitlementCrossingIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: fleetEntitlementCrossedTopic,
			source: 'fleet-entitlement-crossing',
			actorTokenId: 'internal:fleet-entitlement-crossing-subscriptions',
		},
	})
	expect(JSON.stringify(dispatched[0]?.params)).not.toContain('email')
	expect(JSON.stringify(dispatched[0]?.params)).not.toContain('plan')
})
