import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { failedSenderAuthenticationReason } from './auth-verdict.ts'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { upsertEmailSenderRule } from './sender-rules.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const dmarcFail =
	'mx.cloudflare.net; dmarc=fail (p=reject) header.from=example.net; spf=fail smtp.mailfrom=example.net; dkim=fail header.d=example.net'
const dmarcPass = 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'
const bothSpfDkimFailNoDmarc =
	'mx.cloudflare.net; spf=fail smtp.mailfrom=example.net; dkim=fail header.d=example.net; dmarc=none'

test('failed DMARC auto-quarantines when no allow rule matches', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-dmarc-${crypto.randomUUID()}`)

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'stranger@example.net',
			envelopeFrom: 'stranger@example.net',
			authResults: dmarcFail,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: failedSenderAuthenticationReason,
	})
})

test('SPF and DKIM both failing with no DMARC policy auto-quarantines', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-spf-dkim-${crypto.randomUUID()}`)

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'stranger@example.net',
			envelopeFrom: 'stranger@example.net',
			authResults: bothSpfDkimFailNoDmarc,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: failedSenderAuthenticationReason,
	})
})

test('missing auth results fail open as accepted', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`class-missing-${crypto.randomUUID()}`)

	await expect(
		resolveInboundEmailClassification({
			db: env.APP_DB,
			userId,
			fromAddress: 'friend@example.net',
			envelopeFrom: 'friend@example.net',
			authResults: null,
		}),
	).resolves.toEqual({
		classification: 'accepted',
		classificationReason: null,
	})
})

test('allow address rule overrides auto-quarantine for failed auth', async () => {
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
		classification: 'accepted',
		classificationReason: null,
	})
})

test('allow domain rule overrides auto-quarantine for failed auth', async () => {
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
		classification: 'accepted',
		classificationReason: null,
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
			authResults: bothSpfDkimFailNoDmarc,
		}),
	).resolves.toEqual({
		classification: 'quarantined',
		classificationReason: failedSenderAuthenticationReason,
	})
})
