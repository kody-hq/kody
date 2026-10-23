import { expect, test } from 'vitest'
import {
	buildSystemEmailSentEvent,
	buildSystemEmailSentIdempotencyKey,
} from './system-email-sent-subscription-event.ts'

test('system email sent idempotency key prefers provider message id and falls back to sent time', () => {
	const event = buildSystemEmailSentEvent({
		from: 'kody@kody.example.com',
		to: ['reporter@example.com'],
		subject: 'Thanks for the report',
		text: 'We shipped the fix.',
		html: '<p>We shipped the fix.</p>',
		replyTo: 'support@kody.example.com',
		providerMessageId: 'provider-1',
		sentAt: '2026-08-31T16:00:00.000Z',
	})

	expect(
		buildSystemEmailSentIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe('system-email-sent:email.system-message.sent:provider-1:package-1')
	expect(
		buildSystemEmailSentIdempotencyKey({
			event: buildSystemEmailSentEvent({
				from: 'kody@kody.example.com',
				to: ['reporter@example.com'],
				subject: 'Hi',
				sentAt: '2026-08-31T16:00:00.000Z',
			}),
			packageId: 'package-1',
		}),
	).toBe(
		'system-email-sent:email.system-message.sent:2026-08-31T16:00:00.000Z:package-1',
	)
})
