import { expect, test, vi } from 'vitest'
import {
	buildUserCreatedEvent,
	buildUserDeletedEvent,
	buildUserLifecycleIdempotencyKey,
	userCreatedTopic,
	userDeletedTopic,
} from './user-lifecycle-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchUserLifecycleSubscriptionEvent } =
	await import('./user-lifecycle-package-subscriptions.ts')

test('user lifecycle dispatch fans identity snapshots through admin package fan-out', async () => {
	const created = buildUserCreatedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		source: 'oauth',
		createdAt: '2026-08-20T12:00:00.000Z',
	})
	const deleted = buildUserDeletedEvent({
		user: created.user,
		createdAt: '2026-08-20T12:00:00.000Z',
		deletedAt: '2026-08-20T13:00:00.000Z',
	})

	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: {
			getParams: () =>
				| Record<string, unknown>
				| Promise<Record<string, unknown>>
			buildIdempotencyKey: (savedPackage: { id: string }) => string
			[key: string]: unknown
		}) => [
			{
				params: await input.getParams(),
				idempotencyKey: input.buildIdempotencyKey({ id: 'package-1' }),
				input,
			},
		],
	)

	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		APP_BASE_URL: 'https://heykody.dev',
	}
	const createdResult = await dispatchUserLifecycleSubscriptionEvent({
		env,
		event: created,
	})
	const deletedResult = await dispatchUserLifecycleSubscriptionEvent({
		env,
		event: deleted,
	})

	expect(createdResult[0]).toMatchObject({
		params: created,
		idempotencyKey: buildUserLifecycleIdempotencyKey({
			event: created,
			packageId: 'package-1',
		}),
		input: {
			topic: userCreatedTopic,
			source: 'user-lifecycle',
			actorTokenId: 'internal:user-lifecycle-subscriptions',
		},
	})
	expect(deletedResult[0]).toMatchObject({
		params: deleted,
		idempotencyKey: buildUserLifecycleIdempotencyKey({
			event: deleted,
			packageId: 'package-1',
		}),
		input: {
			topic: userDeletedTopic,
			source: 'user-lifecycle',
		},
	})
})
