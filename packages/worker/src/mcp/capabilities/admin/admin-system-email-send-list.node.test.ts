import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { recordSystemEmailSends } from '#worker/email/system-email-sends.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { adminSystemEmailSendListCapability } from './admin-system-email-send-list.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createContext(db: D1Database, roles: Array<string>) {
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('admin-user'),
				username: 'admin',
				email: 'admin@example.com',
				displayName: 'Admin',
				roles,
			},
		}),
	}
}

async function seed(sqlite: DatabaseSync, db: D1Database) {
	const send = (id: string, recipient: string, kind: string, at: string) =>
		recordSystemEmailSends({
			db,
			providerMessageId: id,
			recipients: [recipient],
			sender: 'kody@kody.codes',
			kind,
			now: new Date(at),
		})
	await send(
		'<claim-1@kody.codes>',
		'person@example.test',
		'guest_claim_code',
		'2026-11-04T18:58:00.000Z',
	)
	await send(
		'<claim-2@kody.codes>',
		'Person@Example.test',
		'guest_claim_code',
		'2026-11-04T19:02:00.000Z',
	)
	await send(
		'<verify-1@kody.codes>',
		'typo@example.test',
		'email_verification',
		'2026-11-02T10:00:00.000Z',
	)
	sqlite
		.prepare(
			`UPDATE system_email_sends SET last_status = 'delivered', last_status_at = ? WHERE provider_message_id = ?`,
		)
		.run('2026-11-04T18:58:05.000Z', '<claim-1@kody.codes>')
	sqlite
		.prepare(
			`UPDATE system_email_sends SET last_status = 'failed', last_status_at = ?, hard_bounced_at = ? WHERE provider_message_id = ?`,
		)
		.run(
			'2026-11-02T10:05:00.000Z',
			'2026-11-02T10:05:00.000Z',
			'<verify-1@kody.codes>',
		)
	sqlite
		.prepare(
			`INSERT INTO email_recipient_suppressions (
				recipient, hard_bounce_count, suppressed_at,
				verification_suppressed_at, last_status, last_detail,
				last_hard_bounce_at, created_at, updated_at
			) VALUES ('typo@example.test', 1, NULL, ?, 'failed', 'no usable transport', ?, ?, ?)`,
		)
		.run(
			'2026-11-02T10:05:00.000Z',
			'2026-11-02T10:05:00.000Z',
			'2026-11-02T10:05:00.000Z',
			'2026-11-02T10:05:00.000Z',
		)
}

test('adminSystemEmailSendList requires admin', async () => {
	const { db } = createDb()
	await expect(
		adminSystemEmailSendListCapability.handler({}, createContext(db, ['user'])),
	).rejects.toThrow('lacks required role "admin"')
})

test('admins trace system sends with delivery reports and bounce state', async () => {
	const { sqlite, db } = createDb()
	await seed(sqlite, db)
	const ctx = createContext(db, ['admin'])

	const all = await adminSystemEmailSendListCapability.handler({}, ctx)
	expect(all.has_more).toBe(false)
	expect(
		all.sends.map((send) => [send.provider_message_id, send.delivery_status]),
	).toEqual([
		['<claim-2@kody.codes>', null],
		['<claim-1@kody.codes>', 'delivered'],
		['<verify-1@kody.codes>', 'failed'],
	])
	expect(all.sends[2]).toMatchObject({
		recipient: 'typo@example.test',
		kind: 'email_verification',
		hard_bounced_at: '2026-11-02T10:05:00.000Z',
		suppression: {
			scope: 'verification',
			last_detail: 'no usable transport',
		},
	})
	expect(all.sends[0]?.suppression).toBeNull()

	const claims = await adminSystemEmailSendListCapability.handler(
		{ recipient: 'PERSON@example.test', kind: 'guest_claim_code', limit: 1 },
		ctx,
	)
	expect(claims.sends.map((send) => send.provider_message_id)).toEqual([
		'<claim-2@kody.codes>',
	])
	expect(claims.has_more).toBe(true)

	const one = await adminSystemEmailSendListCapability.handler(
		{ provider_message_id: '<claim-1@kody.codes>' },
		ctx,
	)
	expect(one.sends).toEqual([
		expect.objectContaining({
			recipient: 'person@example.test',
			sent_at: '2026-11-04T18:58:00.000Z',
			delivery_status_at: '2026-11-04T18:58:05.000Z',
		}),
	])

	const recent = await adminSystemEmailSendListCapability.handler(
		{ since: '2026-11-04T00:00:00Z' },
		ctx,
	)
	expect(recent.sends).toHaveLength(2)
})
