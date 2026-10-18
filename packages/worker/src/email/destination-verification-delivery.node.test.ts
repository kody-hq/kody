import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as cloudflareEmailModule from '#app/email/cloudflare-email.ts'
import {
	lookupTransactionalEmailDelivery,
	transactionalEmailDestinationVerificationKind,
	transactionalEmailVerificationKind,
} from './verification-delivery.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const sendCloudflareEmail = vi.fn<
	typeof cloudflareEmailModule.sendCloudflareEmail
>(async () => ({
	ok: true,
	messageId: 'cf-destination-1',
}))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof cloudflareEmailModule.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const { createEmailVerification } = await import('#app/email-verification.ts')
const {
	createEmailDestinationVerification,
	resendEmailDestinationVerification,
} = await import('./destination-verification.ts')

async function createOwnerEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const stableUserId = testStableUserIdFromEmail('owner@example.com')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at,
			created_at
		) VALUES (
			1, 'owner', 'owner@example.com', ${quoteSqlString(stableUserId)},
			'test-password-hash', CURRENT_TIMESTAMP, datetime('now', '-48 hours')
		);
	`)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	return { sqlite, env }
}

test('destination verify send indexes a distinct kind and leaves signup verification indexing alone', async () => {
	const { sqlite, env } = await createOwnerEnv()
	const lookup = (providerMessageId: string) =>
		lookupTransactionalEmailDelivery({ db: env.APP_DB, providerMessageId })
	for (const messageId of [
		'cf-destination-1',
		'cf-destination-2',
		'cf-destination-alerts',
		'cf-signup-1',
	]) {
		sendCloudflareEmail.mockResolvedValueOnce({ ok: true, messageId })
	}
	const request = { env, userId: 1, requestUrl: 'http://example.com' }

	const added = await createEmailDestinationVerification({
		...request,
		email: 'pager@example.com',
	})
	expect(added.created).toBe(true)
	expect(sendCloudflareEmail.mock.calls[0]?.[1]).toMatchObject({
		from: 'owner@inbox.example.com',
		to: 'pager@example.com',
	})
	expect(await lookup('cf-destination-1')).toMatchObject({
		user_id: 1,
		kind: transactionalEmailDestinationVerificationKind,
		recipient: 'pager@example.com',
	})

	await resendEmailDestinationVerification({
		...request,
		destinationId: added.destination.id,
	})
	const alerts = await createEmailDestinationVerification({
		...request,
		email: 'alerts@example.com',
	})
	expect(alerts.created).toBe(true)
	await createEmailVerification({ ...request, email: 'owner@example.com' })

	// The resend retires only its own previous id; other destinations and the
	// signup verification each keep their own index row.
	expect(await lookup('cf-destination-1')).toBeNull()
	const indexed = [
		[
			'cf-destination-2',
			transactionalEmailDestinationVerificationKind,
			'pager@example.com',
		],
		[
			'cf-destination-alerts',
			transactionalEmailDestinationVerificationKind,
			'alerts@example.com',
		],
		['cf-signup-1', transactionalEmailVerificationKind, 'owner@example.com'],
	] as const
	for (const [providerMessageId, kind, recipient] of indexed) {
		expect(await lookup(providerMessageId)).toMatchObject({
			user_id: 1,
			kind,
			recipient,
		})
	}
	expect(
		sqlite
			.prepare(
				`SELECT kind, recipient FROM transactional_email_delivery_index
				 ORDER BY kind ASC, recipient ASC`,
			)
			.all(),
	).toEqual([
		{
			kind: transactionalEmailDestinationVerificationKind,
			recipient: 'alerts@example.com',
		},
		{
			kind: transactionalEmailDestinationVerificationKind,
			recipient: 'pager@example.com',
		},
		{
			kind: transactionalEmailVerificationKind,
			recipient: 'owner@example.com',
		},
	])
})
