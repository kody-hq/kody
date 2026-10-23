import { expect, test } from 'vitest'
import {
	buildUserCreatedEvent,
	buildUserDeletedEvent,
	buildUserLifecycleIdempotencyKey,
	isUserLifecycleEventTopic,
	userCreatedTopic,
	userDeletedTopic,
} from './user-lifecycle-subscription-event.ts'

test('user lifecycle event builders keep a metadata-only identity snapshot', () => {
	const created = buildUserCreatedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		source: 'signup',
		createdAt: '2026-08-20T12:00:00.000Z',
	})
	const deleted = buildUserDeletedEvent({
		user: created.user,
		createdAt: '2026-08-20T12:00:00.000Z',
		deletedAt: '2026-08-20T13:00:00.000Z',
	})

	expect(created).toEqual({
		event: userCreatedTopic,
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		source: 'signup',
		created_at: '2026-08-20T12:00:00.000Z',
		attribution: {
			utm_source: null,
			utm_medium: null,
			utm_campaign: null,
			utm_content: null,
			utm_term: null,
			landing_path: null,
			referrer: null,
		},
	})
	expect(
		buildUserCreatedEvent({
			user: created.user,
			source: 'oauth',
			createdAt: '2026-08-20T12:00:00.000Z',
			attribution: {
				utmSource: 'youtube',
				utmMedium: 'video',
				utmCampaign: 'bwk-2026-08-27',
				utmContent: null,
				utmTerm: null,
				landingPath: '/signup',
				referrer: null,
			},
		}),
	).toEqual({
		event: userCreatedTopic,
		user: created.user,
		source: 'oauth',
		created_at: '2026-08-20T12:00:00.000Z',
		attribution: {
			utm_source: 'youtube',
			utm_medium: 'video',
			utm_campaign: 'bwk-2026-08-27',
			utm_content: null,
			utm_term: null,
			landing_path: '/signup',
			referrer: null,
		},
	})
	expect(deleted).toEqual({
		event: userDeletedTopic,
		user: created.user,
		created_at: '2026-08-20T12:00:00.000Z',
		deleted_at: '2026-08-20T13:00:00.000Z',
	})
	expect(isUserLifecycleEventTopic('user.updated')).toBe(false)
	expect(
		buildUserLifecycleIdempotencyKey({
			event: created,
			packageId: 'package-1',
		}),
	).toBe(
		'user-lifecycle:user.created:user-1:2026-08-20T12:00:00.000Z:package-1',
	)
	expect(
		buildUserLifecycleIdempotencyKey({
			event: deleted,
			packageId: 'package-1',
		}),
	).toBe(
		'user-lifecycle:user.deleted:user-1:2026-08-20T13:00:00.000Z:package-1',
	)
})

test('user.deleted created_at normalizes stored signup timestamps to ISO', () => {
	const user = { id: 'user-1', username: 'ada', email: 'ada@example.com' }
	const deletedAt = '2026-08-20T13:00:00.000Z'
	const createdAtFor = (createdAt: string) =>
		buildUserDeletedEvent({ user, createdAt, deletedAt }).created_at

	// SQLite CURRENT_TIMESTAMP rows carry no zone and are UTC.
	expect(createdAtFor('2026-08-20 12:59:30')).toBe('2026-08-20T12:59:30.000Z')
	expect(createdAtFor('2026-08-20T12:59:30Z')).toBe('2026-08-20T12:59:30.000Z')
	expect(createdAtFor('2026-08-20T12:59:30.123Z')).toBe(
		'2026-08-20T12:59:30.123Z',
	)
	expect(createdAtFor('not-a-date')).toBe('not-a-date')
	expect(
		buildUserDeletedEvent({ user, createdAt: deletedAt, deletedAt }),
	).toEqual({
		event: userDeletedTopic,
		user,
		created_at: deletedAt,
		deleted_at: deletedAt,
	})
})
