import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminDomain } from './domain.ts'
import { adminFleetErrorRateCapability } from './admin-fleet-error-rate.ts'

const loadMocks = vi.hoisted(() => ({
	loadAdminFleetErrorRateData: vi.fn(),
}))

vi.mock('#worker/admin/fleet-error-rate-data.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#worker/admin/fleet-error-rate-data.ts')
		>()
	return {
		...actual,
		loadAdminFleetErrorRateData: (...args: Array<unknown>) =>
			loadMocks.loadAdminFleetErrorRateData(...args),
	}
})

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createContext(roles: Array<string>, db: D1Database) {
	const adminStableUserId = testStableUserIdFromEmail('admin@example.com')
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(adminStableUserId),
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
	}
}

test('adminFleetErrorRate is registered read-only admin and returns aggregates', async () => {
	expect(adminFleetErrorRateCapability.requiredRole).toBe('admin')
	expect(adminFleetErrorRateCapability.readOnly).toBe(true)
	expect(
		adminDomain.capabilities.some((c) => c.name === 'adminFleetErrorRate'),
	).toBe(true)

	const { sqlite, db } = createMigratedDb()
	const adminStableId = testStableUserIdFromEmail('admin@example.com')
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'opslead',
			'admin@example.com',
			${quoteSqlString(adminStableId)},
			'hash'
		);
	`)

	const userCtx = createContext(['user'], db)
	await expect(
		adminFleetErrorRateCapability.handler({}, userCtx),
	).rejects.toThrow('lacks required role "admin"')

	loadMocks.loadAdminFleetErrorRateData.mockResolvedValue({
		snapshot: {
			available: true,
			updatedAt: '2026-10-20T12:00:00.000Z',
			environment: 'production',
			day: null,
			hour: null,
			lastAlertAt: null,
			concentration: null,
		},
		days: 7,
		startDay: '2026-10-14',
		endDay: '2026-10-20',
		dailyAvailable: true,
		daily: [
			{
				day: '2026-10-20',
				errorCount: 4,
				caughtCount: 11,
				usersWithErrors: 2,
			},
		],
		byErrorName: {
			available: true,
			failedRuns: [
				{
					day: '2026-10-20',
					errorName: 'credential_need_undeclared',
					count: 3,
				},
			],
			staticCalls: [
				{
					day: '2026-10-20',
					errorName: 'credential_need_undeclared',
					count: 40,
				},
			],
		},
		filter: null,
	})

	const adminCtx = createContext(['admin'], db)
	const result = await adminFleetErrorRateCapability.handler({}, adminCtx)
	expect(result.snapshot.available).toBe(true)
	expect(result.daily).toEqual([
		{
			day: '2026-10-20',
			errorCount: 4,
			caughtCount: 11,
			usersWithErrors: 2,
		},
	])
	expect(result.byErrorName.staticCalls[0]?.errorName).toBe(
		'credential_need_undeclared',
	)
	expect(result.filter).toBeNull()
	expect(JSON.stringify(result)).not.toMatch(/@[a-z]|username|handle/i)
	expect(loadMocks.loadAdminFleetErrorRateData).toHaveBeenCalledWith(
		expect.objectContaining({
			days: 7,
			stableUserId: undefined,
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminFleetErrorRate',
			result: 'success',
			reason: expect.stringContaining('filter=fleet'),
		}),
	)
	expect(auditEventSummaries()).toContain('adminFleetErrorRate:success')
})

test('adminFleetErrorRate accepts days and stableUserId filter', async () => {
	const { sqlite, db } = createMigratedDb()
	const adminStableId = testStableUserIdFromEmail('admin@example.com')
	const targetId = 'c'.repeat(64)
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			'opslead',
			'admin@example.com',
			${quoteSqlString(adminStableId)},
			'hash'
		);
	`)

	loadMocks.loadAdminFleetErrorRateData.mockResolvedValue({
		snapshot: {
			available: false,
			updatedAt: null,
			environment: null,
			day: null,
			hour: null,
			lastAlertAt: null,
			concentration: null,
		},
		days: 3,
		startDay: '2026-10-18',
		endDay: '2026-10-20',
		dailyAvailable: true,
		daily: [
			{
				day: '2026-10-20',
				errorCount: 1,
				caughtCount: 0,
				usersWithErrors: 1,
			},
		],
		byErrorName: {
			available: true,
			failedRuns: [],
			staticCalls: [{ day: '2026-10-20', errorName: 'Error', count: 1 }],
		},
		filter: { stableUserId: targetId },
	})

	const result = await adminFleetErrorRateCapability.handler(
		{ days: 3, stableUserId: targetId },
		createContext(['admin'], db),
	)
	expect(result.filter).toEqual({ stableUserId: targetId })
	expect(loadMocks.loadAdminFleetErrorRateData).toHaveBeenCalledWith(
		expect.objectContaining({
			days: 3,
			stableUserId: targetId,
		}),
	)
	expect(result).not.toHaveProperty('username')
})
