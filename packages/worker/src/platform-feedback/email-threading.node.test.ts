import { expect, test } from 'vitest'
import {
	buildPlatformFeedbackFollowUpMailMeta,
	normalizeRfcMessageId,
} from './email-threading.ts'

test('normalizeRfcMessageId wraps bare ids and rejects unusable values', () => {
	expect(normalizeRfcMessageId('<ack@email.example>')).toBe(
		'<ack@email.example>',
	)
	expect(normalizeRfcMessageId('  ack@email.example  ')).toBe(
		'<ack@email.example>',
	)
	expect(normalizeRfcMessageId('email_1')).toBeNull()
	expect(normalizeRfcMessageId('<>')).toBeNull()
	expect(normalizeRfcMessageId('<no-at-sign>')).toBeNull()
	expect(normalizeRfcMessageId('<bad\nid@email.example>')).toBeNull()
	expect(normalizeRfcMessageId(null)).toBeNull()
	expect(normalizeRfcMessageId(undefined)).toBeNull()
	expect(normalizeRfcMessageId('')).toBeNull()
	expect(normalizeRfcMessageId('   ')).toBeNull()
	expect(normalizeRfcMessageId(`<${'a'.repeat(996)}@x>`)).toBeNull()
})

test('follow-up mail meta threads when an acknowledgement Message-ID is stored', () => {
	const meta = buildPlatformFeedbackFollowUpMailMeta({
		acknowledgementMessageId: 'ack@cf.example',
		fallbackSubject: 'We resolved your Kody feedback',
	})
	expect(meta).toEqual({
		subject: 'Re: We got your Kody feedback',
		threaded: true,
		headers: {
			'In-Reply-To': '<ack@cf.example>',
			References: '<ack@cf.example>',
		},
	})
})

test('follow-up mail meta falls back when no acknowledgement Message-ID is stored', () => {
	const fallbackSubject = 'We resolved your Kody feedback'
	expect(
		buildPlatformFeedbackFollowUpMailMeta({
			acknowledgementMessageId: null,
			fallbackSubject,
		}),
	).toEqual({
		subject: fallbackSubject,
		threaded: false,
	})
	expect(
		buildPlatformFeedbackFollowUpMailMeta({
			acknowledgementMessageId: 'not-a-message-id',
			fallbackSubject: 'An update on your Kody feedback',
		}),
	).toEqual({
		subject: 'An update on your Kody feedback',
		threaded: false,
	})
})
