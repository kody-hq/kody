import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AdminPackageSubscriptions from '#worker/package-invocations/admin-package-subscriptions.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildFleetPackageErrorRateElevatedEvent,
	buildFleetPackageErrorRateIdempotencyKey,
	fleetPackageErrorRateElevatedTopic,
} from './fleet-package-error-rate-subscription-event.ts'

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

const { dispatchFleetPackageErrorRateSubscriptionEvent } =
	await import('./fleet-package-error-rate-subscriptions.ts')

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

test('fleet package error-rate dispatch fans metadata-only events through admin package fan-out', async () => {
	const event = buildFleetPackageErrorRateElevatedEvent({
		eventId: 'day:2026-08-22T19:00:00.000Z',
		statusUrl: 'https://status.kody.codes',
		insightsUrl: 'https://kody.codes/admin/insights',
		environment: 'production',
		observedAt: '2026-08-22T19:32:00.000Z',
		window: 'day',
		reason: 'absolute_delta',
		recent: {
			start: '2026-08-21T19:00:00.000Z',
			end: '2026-08-22T19:00:00.000Z',
			combined: { events: 80, errors: 16, rate: 0.2 },
			by_metric: [
				{
					metric: 'package_export',
					events: 80,
					errors: 16,
					rate: 0.2,
				},
				{
					metric: 'package_static_call',
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run', events: 0, errors: 0, rate: null },
				{ metric: 'workflow_run', events: 0, errors: 0, rate: null },
			],
		},
		previous: {
			start: '2026-08-20T19:00:00.000Z',
			end: '2026-08-21T19:00:00.000Z',
			combined: { events: 80, errors: 2, rate: 0.025 },
			by_metric: [
				{
					metric: 'package_export',
					events: 80,
					errors: 2,
					rate: 0.025,
				},
				{
					metric: 'package_static_call',
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run', events: 0, errors: 0, rate: null },
				{ metric: 'workflow_run', events: 0, errors: 0, rate: null },
			],
		},
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

	await dispatchFleetPackageErrorRateSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://kody.codes',
		},
		event,
	})

	expect(dispatched[0]).toMatchObject({
		params: event,
		idempotencyKey: buildFleetPackageErrorRateIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: fleetPackageErrorRateElevatedTopic,
			source: 'fleet-package-error-rate',
			actorTokenId: 'internal:fleet-package-error-rate-subscriptions',
		},
	})
	expect(event.concentration).toBeNull()
	expect(JSON.stringify(dispatched[0]?.params)).not.toContain('user_id')
	expect(JSON.stringify(dispatched[0]?.params)).not.toContain('error_message')
})
