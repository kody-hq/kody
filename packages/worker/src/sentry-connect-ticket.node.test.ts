import { expect, test } from 'vitest'
import {
	redactConnectTicket,
	redactKodyCredentialsInSentryEvent,
} from './sentry-options.ts'

test('connect tickets never reach Sentry', () => {
	expect(
		redactConnectTicket(
			'https://api.test/v1/execution-contexts/connect?ticket=ec_a.secret&x=1',
		),
	).toBe('https://api.test/v1/execution-contexts/connect?ticket=[redacted]&x=1')
	expect(redactConnectTicket('ticket=ec_a.secret')).toBe('ticket=[redacted]')
	const event = redactKodyCredentialsInSentryEvent({
		type: undefined,
		request: {
			url: 'https://api.test/v1/execution-contexts/connect?ticket=ec_a.s',
			query_string: 'ticket=ec_a.s',
		},
	} as never)
	expect(event.request?.url).not.toContain('ec_a.s')
	expect(event.request?.query_string).toBe('ticket=[redacted]')
})
