import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AdminPackageSubscriptions from '#worker/package-invocations/admin-package-subscriptions.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildStatusIncidentIdempotencyKey,
	buildStatusIncidentOpenedEvent,
	buildStatusIncidentResolvedEvent,
	statusIncidentOpenedTopic,
	statusIncidentResolvedTopic,
} from './subscription-event.ts'

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

const { dispatchStatusIncidentSubscriptionEvent } =
	await import('./package-subscriptions.ts')

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

test('status incident dispatch fans metadata-only events through admin package fan-out', async () => {
	const opened = buildStatusIncidentOpenedEvent({
		component: 'app_db',
		detail: 'timeout',
		startedAt: '2026-08-17T01:11:00.000Z',
		statusUrl: 'https://status.kody.codes',
	})
	const resolved = buildStatusIncidentResolvedEvent({
		component: 'app_db',
		detail: 'timeout',
		startedAt: '2026-08-17T01:11:00.000Z',
		resolvedAt: '2026-08-17T01:13:00.000Z',
		statusUrl: 'https://status.kody.codes',
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

	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		APP_BASE_URL: 'https://heykody.dev',
	}
	await dispatchStatusIncidentSubscriptionEvent({
		env,
		event: opened,
	})
	await dispatchStatusIncidentSubscriptionEvent({
		env,
		event: resolved,
	})

	expect(dispatched[0]).toMatchObject({
		params: opened,
		idempotencyKey: buildStatusIncidentIdempotencyKey({
			event: opened,
			packageId: 'package-1',
		}),
		input: {
			topic: statusIncidentOpenedTopic,
			source: 'status-incidents',
			actorTokenId: 'internal:status-incident-subscriptions',
		},
	})
	expect(dispatched[1]).toMatchObject({
		params: resolved,
		idempotencyKey: buildStatusIncidentIdempotencyKey({
			event: resolved,
			packageId: 'package-1',
		}),
		input: {
			topic: statusIncidentResolvedTopic,
			source: 'status-incidents',
		},
	})
	expect(JSON.stringify(dispatched[0]?.params)).not.toContain('user_id')
	expect(JSON.stringify(dispatched[0]?.params)).not.toContain('probe')
})
