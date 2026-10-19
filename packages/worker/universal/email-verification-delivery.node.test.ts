import { expect, test } from 'vitest'
import {
	acceptedEmailVerificationDelivery,
	describeEmailVerificationDelivery,
	isAdminUserVerificationFilter,
	isStalledEmailVerificationDelivery,
	shouldPollEmailVerificationDelivery,
} from './email-verification-delivery.ts'

test('stalled verification is derived from accepted age, not a stored status', () => {
	const now = new Date('2026-09-01T10:00:00.000Z')
	expect(
		isStalledEmailVerificationDelivery(
			{
				emailVerified: false,
				delivery: acceptedEmailVerificationDelivery('2026-09-01T08:45:16.921Z'),
			},
			now,
		),
	).toBe(true)
	expect(
		isStalledEmailVerificationDelivery(
			{
				emailVerified: false,
				delivery: acceptedEmailVerificationDelivery('2026-09-01T09:30:00.000Z'),
			},
			now,
		),
	).toBe(false)
	expect(
		isStalledEmailVerificationDelivery(
			{
				emailVerified: true,
				delivery: acceptedEmailVerificationDelivery('2026-09-01T08:00:00.000Z'),
			},
			now,
		),
	).toBe(false)
	expect(isAdminUserVerificationFilter('accepted')).toBe(false)
})

test('accepted delivery waits honestly and keeps polling', () => {
	const missing = describeEmailVerificationDelivery(null)
	expect(missing.indicator).toBe('waiting')
	expect(missing.headline).toBeNull()
	expect(shouldPollEmailVerificationDelivery(null)).toBe(true)

	const accepted = describeEmailVerificationDelivery(
		acceptedEmailVerificationDelivery(),
	)
	expect(accepted.indicator).toBe('waiting')
	expect(accepted.headline).toMatch(/waiting for delivery confirmation/i)
	expect(accepted.detail).toMatch(/accepted the message/i)
	expect(accepted.helpHref).toBeNull()
	expect(
		shouldPollEmailVerificationDelivery(acceptedEmailVerificationDelivery()),
	).toBe(true)
})

test('delivered and failed map to terminal indicator phases', () => {
	const delivered = describeEmailVerificationDelivery({
		status: 'delivered',
		class: null,
		at: '2026-10-15T12:00:00.000Z',
	})
	expect(delivered.indicator).toBe('delivered')
	expect(
		shouldPollEmailVerificationDelivery({
			status: 'delivered',
			class: null,
			at: '2026-10-15T12:00:00.000Z',
		}),
	).toBe(false)

	const failed = describeEmailVerificationDelivery({
		status: 'bounced',
		class: null,
		at: '2026-10-15T12:00:00.000Z',
	})
	expect(failed.indicator).toBe('failed')
	expect(failed.tone).toBe('error')
	expect(failed.helpHref).toBe('/docs/cant-open-or-get-mail')
	expect(failed.helpLabel).toMatch(/can't open kody\.codes/i)
	expect(failed.detail).toMatch(/social login/i)
	expect(
		shouldPollEmailVerificationDelivery({
			status: 'bounced',
			class: null,
			at: '2026-10-15T12:00:00.000Z',
		}),
	).toBe(false)
})

test('deferred delivery shows delayed and keeps polling', () => {
	const delayed = describeEmailVerificationDelivery({
		status: 'deferred',
		class: null,
		at: '2026-10-15T12:00:00.000Z',
	})
	expect(delayed.indicator).toBe('delayed')
	expect(
		shouldPollEmailVerificationDelivery({
			status: 'deferred',
			class: null,
			at: '2026-10-15T12:00:00.000Z',
		}),
	).toBe(true)
})

test('sender_block copy tells people to try another address', () => {
	const blocked = describeEmailVerificationDelivery({
		status: 'failed',
		class: 'sender_block',
		at: '2026-10-15T12:00:00.000Z',
	})
	expect(blocked.canResend).toBe(false)
	expect(blocked.detail).toMatch(/blocking our domain right now/i)
	expect(blocked.detail).toMatch(/try another address/i)
	expect(blocked.detail).toMatch(/support/i)
	expect(blocked.helpHref).toBe('/docs/cant-open-or-get-mail')
})
