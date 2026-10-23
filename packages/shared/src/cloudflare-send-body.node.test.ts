import { expect, test } from 'vitest'
import { toCloudflareSendBody } from './cloudflare-send-body.ts'

test('toCloudflareSendBody maps replyTo to reply_to and omits camelCase', () => {
	expect(
		toCloudflareSendBody({
			from: 'kody@kody.codes',
			to: 'user@example.com',
			subject: 'Override',
			html: '<p>Override</p>',
			replyTo: '  abuse@kody.codes  ',
		}),
	).toEqual({
		from: 'kody@kody.codes',
		to: 'user@example.com',
		subject: 'Override',
		html: '<p>Override</p>',
		reply_to: 'abuse@kody.codes',
	})
	expect(
		toCloudflareSendBody({
			from: 'support@kody.codes',
			to: 'user@example.com',
			subject: 'Blank',
			html: '<p>Blank</p>',
			replyTo: '   ',
		}),
	).toEqual({
		from: 'support@kody.codes',
		to: 'user@example.com',
		subject: 'Blank',
		html: '<p>Blank</p>',
	})
})
