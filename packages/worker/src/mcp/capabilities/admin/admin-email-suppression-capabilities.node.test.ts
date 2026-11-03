import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { loadRecipientSuppression } from '#worker/email/recipient-suppression.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { adminEmailSuppressionClearCapability } from './admin-email-suppression-clear.ts'
import { adminEmailSuppressionListCapability } from './admin-email-suppression-list.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	return createD1FromSqlite(sqlite)
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

async function seed(db: D1Database) {
	const insert = (
		recipient: string,
		count: number,
		suppressedAt: string | null,
		verificationAt: string | null,
		updatedAt: string,
	) =>
		db
			.prepare(
				`INSERT INTO email_recipient_suppressions (
					recipient, hard_bounce_count, suppressed_at,
					verification_suppressed_at, last_status, last_detail,
					last_hard_bounce_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'bounced', '550 user unknown', ?, ?, ?)`,
			)
			.bind(
				recipient,
				count,
				suppressedAt,
				verificationAt,
				updatedAt,
				updatedAt,
				updatedAt,
			)
			.run()
	await insert(
		'gone@example.com',
		2,
		'2026-11-02T00:00:00.000Z',
		null,
		'2026-11-02T00:00:00.000Z',
	)
	await insert(
		'typo@example.com',
		0,
		null,
		'2026-11-01T00:00:00.000Z',
		'2026-11-01T00:00:00.000Z',
	)
	await insert('once@example.com', 1, null, null, '2026-11-03T00:00:00.000Z')
}

test('admin email suppression capabilities require admin', async () => {
	const db = createDb()
	await seed(db)
	await expect(
		adminEmailSuppressionListCapability.handler(
			{},
			createContext(db, ['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	await expect(
		adminEmailSuppressionClearCapability.handler(
			{ recipient: 'gone@example.com' },
			createContext(db, ['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(
		await loadRecipientSuppression({ db, recipient: 'gone@example.com' }),
	).not.toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)
})

test('admins list suppressions and clear one address', async () => {
	const db = createDb()
	await seed(db)
	const ctx = createContext(db, ['admin'])

	const list = await adminEmailSuppressionListCapability.handler({}, ctx)
	expect(list.threshold).toBe(2)
	expect(list.has_more).toBe(false)
	expect(list.suppressions.map((row) => [row.recipient, row.scope])).toEqual([
		['gone@example.com', 'all'],
		['typo@example.com', 'verification'],
	])
	const withTracking = await adminEmailSuppressionListCapability.handler(
		{ include_tracking: true, limit: 1 },
		ctx,
	)
	expect(withTracking.suppressions).toEqual([
		expect.objectContaining({
			recipient: 'once@example.com',
			scope: 'tracking',
		}),
	])
	expect(withTracking.has_more).toBe(true)
	const one = await adminEmailSuppressionListCapability.handler(
		{ recipient: 'Gone@Example.com' },
		ctx,
	)
	expect(one.suppressions).toEqual([
		expect.objectContaining({
			recipient: 'gone@example.com',
			hard_bounce_count: 2,
		}),
	])

	const cleared = await adminEmailSuppressionClearCapability.handler(
		{ recipient: 'GONE@example.com' },
		ctx,
	)
	expect(cleared).toMatchObject({
		cleared: true,
		previous: { recipient: 'gone@example.com', scope: 'all' },
	})
	expect(
		await loadRecipientSuppression({ db, recipient: 'gone@example.com' }),
	).toBeNull()
	await expect(
		adminEmailSuppressionClearCapability.handler(
			{ recipient: 'gone@example.com' },
			ctx,
		),
	).rejects.toThrow('No email suppression found')

	expect(auditEventSummaries()).toEqual(
		expect.arrayContaining([
			'adminEmailSuppressionList:success',
			'adminEmailSuppressionClear:success',
		]),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			reason: 'recipient=***@example.com;scope=all',
		}),
	)
})
