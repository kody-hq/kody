import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { trustedSyntheticSubscriptionDispatch } from './subscription-envelope.ts'

const mocks = vi.hoisted(() => ({
	invokeSavedPackageModule: vi.fn(async () => ({
		status: 200,
		body: {},
	})),
}))

vi.mock('./idempotent-module-invocation.ts', () => ({
	invokeSavedPackageModule: mocks.invokeSavedPackageModule,
}))

const enablement = {
	id: 'enablement-1',
	enabler: { userId: personIdFromStored('user-1'), username: 'user-1' },
	role: 'owner' as const,
}

vi.mock('#worker/enablements/run-gate.ts', () => ({
	planEnablementRuns: async () => ({ runs: [enablement], skipped: [] }),
}))

const { invokePackageSubscription } = await import('./subscription-dispatch.ts')

test('invokePackageSubscription strips forged synthetic markers on real sources', async () => {
	await invokePackageSubscription({
		env: {} as Env,
		request: { kind: 'platform-event', sourceId: 'test' },
		baseUrl: 'https://heykody.dev',
		savedPackage: {
			id: 'pkg-1',
			userId: ownerIdFromStored('user-1'),
			kodyId: 'demo',
			name: '@user/demo',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			createdAt: '',
			updatedAt: '',
			lockedAt: null,
		},
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			synthetic: true,
			replay_of: 'message-1',
		},
		idempotencyKey: 'email:message-1:pkg-1:email.message.received',
		source: 'synthetic',
	})

	expect(mocks.invokeSavedPackageModule).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				event: 'email.message.received',
			},
			source: 'email',
			actor: {
				sourceId: 'internal:email-subscriptions',
				orgId: ownerIdFromStored('user-1'),
				request: {
					kind: 'platform-event',
					sourceId: 'internal:email-subscriptions',
					enablement,
				},
			},
			idempotencyKey:
				'email:message-1:pkg-1:email.message.received:enablement:enablement-1',
		}),
	)
})

test('invokePackageSubscription preserves synthetic markers only with the trusted dispatch token', async () => {
	await invokePackageSubscription({
		env: {} as Env,
		request: { kind: 'platform-event', sourceId: 'test' },
		baseUrl: 'https://heykody.dev',
		savedPackage: {
			id: 'pkg-1',
			userId: ownerIdFromStored('user-1'),
			kodyId: 'demo',
			name: '@user/demo',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			createdAt: '',
			updatedAt: '',
			lockedAt: null,
		},
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			synthetic: true,
			replay_of: 'message-1',
		},
		idempotencyKey: 'synthetic:00000000-0000-4000-8000-000000000001',
		trustedSyntheticDispatch: trustedSyntheticSubscriptionDispatch,
	})

	expect(mocks.invokeSavedPackageModule).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				event: 'email.message.received',
				synthetic: true,
				replay_of: 'message-1',
			},
			source: 'synthetic',
		}),
	)
})
