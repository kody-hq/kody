import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { upsertEmailSenderRule } from './sender-rules.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const dmarcFail =
	'mx.example.com; dmarc=fail (p=reject) header.from=example.net; spf=fail smtp.mailfrom=example.net; dkim=fail header.d=example.net'
const dmarcPass = 'mx.example.com; spf=pass; dkim=pass; dmarc=pass'
/** SPF pass without DMARC or From alignment — authenticated at verdict, not From. */
const spfPassUnaaligned =
	'mx.example.com; spf=pass smtp.mailfrom=attacker.example; dkim=none; dmarc=none'

test('spoofed sender matching an allow address rule is quarantined', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-spoof-addr-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.net',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'friend@example.net',
			envelopeFrom: 'friend@example.net',
			authResults: dmarcFail,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender failed DMARC authentication.',
	})
})

test('spoofed sender matching an allow domain rule is quarantined', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-spoof-dom-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'domain',
		value: 'trusted.example',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'news@trusted.example',
			envelopeFrom: 'news@trusted.example',
			authResults: dmarcFail,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender failed DMARC authentication.',
	})
})

test('authenticated sender matching an allow rule is accepted', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-auth-allow-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.net',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'friend@example.net',
			envelopeFrom: 'friend@example.net',
			authResults: dmarcPass,
		}),
	).resolves.toEqual({
		classification: 'accepted',
		classificationReason: null,
	})
})

test('block rule quarantines authenticated mail', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-block-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'blocked@spam.example',
		effect: 'block',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'blocked@spam.example',
			envelopeFrom: 'blocked@spam.example',
			authResults: dmarcPass,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: 'Sender matched block rule blocked@spam.example.',
	})
})

test('allow rule does not accept when envelope SPF passes but From is unaligned', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-unaligned-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.net',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'friend@example.net',
			envelopeFrom: 'bounce@attacker.example',
			authResults: spfPassUnaaligned,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason:
			'Sender matched allow rule but From did not authenticate.',
	})
})

test('allow rule matches RFC5322 From, not a different envelope sender', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-from-match-${crypto.randomUUID()}`)
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'allowed@attacker.example',
		effect: 'allow',
	})

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'victim@bank.example',
			envelopeFrom: 'allowed@attacker.example',
			authResults: spfPassUnaaligned,
		}),
	).resolves.toEqual({
		classification: 'accepted',
		classificationReason: null,
	})
})
