import { expect, test } from 'vitest'
import { resolveEmailSendingEventSubscriptionDomains } from './production-resources.ts'

test('resolveEmailSendingEventSubscriptionDomains keeps one entry when domains match', () => {
	expect(
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: 'kody.codes',
			systemDomain: 'kody.codes',
		}),
	).toEqual([{ domain: 'kody.codes', kind: 'user' }])
})

test('resolveEmailSendingEventSubscriptionDomains subscribes both inbox and system domains', () => {
	expect(
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: 'inbox.kody.codes',
			systemDomain: 'kody.codes',
		}),
	).toEqual([
		{ domain: 'inbox.kody.codes', kind: 'user' },
		{ domain: 'kody.codes', kind: 'system' },
	])
})

test('resolveEmailSendingEventSubscriptionDomains normalizes case and trailing dots', () => {
	expect(
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: 'Inbox.Kody.Codes.',
			systemDomain: 'KODY.CODES',
		}),
	).toEqual([
		{ domain: 'inbox.kody.codes', kind: 'user' },
		{ domain: 'kody.codes', kind: 'system' },
	])
})
