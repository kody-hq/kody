import { expect, test } from 'vitest'
import { resolveTransactionalSenderReplyTo } from './transactional-sender-reply-to.ts'

test('kody@ From defaults Reply-To to support@ on the same domain unless overridden', () => {
	expect(resolveTransactionalSenderReplyTo({ from: 'kody@kody.codes' })).toBe(
		'support@kody.codes',
	)
	expect(
		resolveTransactionalSenderReplyTo({
			from: '  Kody@Kody.Example.com  ',
		}),
	).toBe('support@kody.example.com')
	expect(
		resolveTransactionalSenderReplyTo({
			from: 'kody@kody.codes',
			replyTo: '  Abuse@Kody.codes  ',
		}),
	).toBe('Abuse@Kody.codes')
	expect(
		resolveTransactionalSenderReplyTo({
			from: 'kody@kody.codes',
			replyTo: '   ',
		}),
	).toBe('support@kody.codes')
	expect(
		resolveTransactionalSenderReplyTo({ from: 'support@kody.codes' }),
	).toBeUndefined()
	expect(
		resolveTransactionalSenderReplyTo({
			from: 'alice@inbox.kody.codes',
		}),
	).toBeUndefined()
	expect(resolveTransactionalSenderReplyTo({ from: 'kody+' })).toBeUndefined()
	expect(resolveTransactionalSenderReplyTo({ from: '' })).toBeUndefined()
})
