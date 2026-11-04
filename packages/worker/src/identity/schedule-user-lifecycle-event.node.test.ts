import { afterEach, expect, test, vi } from 'vitest'
import type * as CloudflareWorkers from 'cloudflare:workers'
import {
	buildUserGuestClaimedEvent,
	buildUserLifecycleIdempotencyKey,
} from './user-lifecycle-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	waitUntil: vi.fn((promise: Promise<unknown>) => {
		void promise
	}),
}))
vi.mock('./user-lifecycle-package-subscriptions.ts', () => ({
	dispatchUserLifecycleSubscriptionEvent: mocks.dispatch,
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof CloudflareWorkers>()),
	waitUntil: mocks.waitUntil,
}))

const {
	scheduleGuestClaimedEvent,
	scheduleUserCreatedEvent,
	scheduleUserDeletedEvent,
} = await import('./schedule-user-lifecycle-event.ts')

const env = {
	APP_DB: {} as D1Database,
	BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	APP_BASE_URL: 'https://kody.test',
}
const identity = {
	id: 'person-guest',
	username: 'guest-abc',
	email: 'abc@guest.kody.invalid',
}
const claimInput = {
	mode: 'merge' as const,
	method: 'signed_in_merge' as const,
	provider: null,
	user: { id: 'person-owner', username: 'owner', email: 'o@example.test' },
	guest: {
		id: 'person-guest',
		username: 'guest-abc',
		clientName: 'Agent',
		createdAt: '2026-11-04 07:00:00',
		expiresAt: '2026-11-05T07:00:00.000Z',
		phase: 'active' as const,
	},
	claimedAt: '2026-11-04T09:00:00.000Z',
	counts: {
		packages: 1,
		repos: 0,
		memories: 2,
		secrets: 0,
		connections: 0,
		mcp_servers: 0,
		apps: 0,
		jobs: 0,
		webhooks: 0,
		runs: 4,
	},
	renamedPackages: 1,
}

function scheduleAll() {
	scheduleUserCreatedEvent({
		env,
		user: identity,
		source: 'guest',
		createdAt: '2026-11-04T07:00:00.000Z',
		guest: {
			client_name: 'Agent',
			expires_at: '2026-11-05T07:00:00.000Z',
			delete_at: '2026-11-12T07:00:00.000Z',
		},
	})
	scheduleGuestClaimedEvent({ env, ...claimInput })
	scheduleUserDeletedEvent({
		env,
		user: identity,
		createdAt: '2026-11-04T07:00:00.000Z',
	})
}

afterEach(() => {
	mocks.dispatch.mockReset()
	mocks.waitUntil.mockClear()
})

test('guest events dispatch the documented payloads without waiting on delivery', () => {
	mocks.dispatch.mockReturnValue(new Promise(() => {}))
	scheduleAll()
	expect(mocks.waitUntil).toHaveBeenCalledTimes(3)
	return vi.waitFor(() => {
		expect(mocks.dispatch).toHaveBeenCalledTimes(3)
		const [created, claimed, deleted] = mocks.dispatch.mock.calls.map(
			([input]) => input.event,
		)
		expect(created).toMatchObject({
			event: 'user.created',
			source: 'guest',
			user: identity,
			guest: {
				client_name: 'Agent',
				expires_at: '2026-11-05T07:00:00.000Z',
				delete_at: '2026-11-12T07:00:00.000Z',
			},
		})
		expect(claimed).toEqual(buildUserGuestClaimedEvent(claimInput))
		expect(claimed).toMatchObject({
			user_created: false,
			guest: { created_at: '2026-11-04T07:00:00.000Z' },
		})
		expect(deleted).toMatchObject({ event: 'user.deleted', user: identity })
		expect(
			buildUserLifecycleIdempotencyKey({ event: claimed, packageId: 'pkg-1' }),
		).toBe(
			'user-lifecycle:user.guest_claimed:person-guest:2026-11-04T09:00:00.000Z:pkg-1',
		)
	})
})

test('a throwing, rejecting, or unavailable dispatch never throws to the caller', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	mocks.dispatch.mockImplementation(() => {
		throw new Error('sync boom')
	})
	expect(scheduleAll).not.toThrow()
	mocks.dispatch.mockRejectedValue(new Error('async boom'))
	expect(scheduleAll).not.toThrow()
	mocks.waitUntil.mockImplementationOnce(() => {
		throw new Error('no request context')
	})
	expect(scheduleAll).not.toThrow()
	await vi.waitFor(() =>
		expect(
			warn.mock.calls.filter(
				([message]) =>
					message === 'user-lifecycle-subscription-dispatch-failed',
			).length,
		).toBeGreaterThanOrEqual(9),
	)
	warn.mockRestore()
})
