import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import type * as RunRecordsService from '#worker/run-records/service.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn<typeof AuditLog.logAuditEvent>(async () => ({
		persisted: false,
		failedSinks: [],
	})),
	inspectRunLogSqlBilling: vi.fn(),
	loadAdminUserByTarget: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Parameters<typeof AuditLog.logAuditEvent>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#worker/run-records/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RunRecordsService>()
	return {
		...actual,
		inspectRunLogSqlBilling: (...args: Array<unknown>) =>
			mockModule.inspectRunLogSqlBilling(...args),
	}
})

vi.mock('#worker/admin/users-data.ts', () => ({
	loadAdminUserByTarget: (...args: Array<unknown>) =>
		mockModule.loadAdminUserByTarget(...args),
}))

const { adminRunLogSqlBillingCapability } =
	await import('./admin-run-log-sql-billing.ts')

const targetStableUserId = testStableUserIdFromEmail('kent@example.com')
const adminStableUserId = testStableUserIdFromEmail('admin@example.com')

function inspectionFixture() {
	return {
		schemaVersion: 11,
		billing: {
			databaseSize: 4096,
			since: '2026-11-15T00:00:00.000Z',
			rowsReadTotal: 12,
			rowsWrittenTotal: 3,
			statements: [
				{
					sql: 'SELECT r.* FROM runs r WHERE r.id = ? LIMIT 1',
					rowsRead: 12,
					rowsWritten: 0,
					calls: 1,
					maxRowsRead: 12,
				},
			],
		},
		runLogsIndexes: [
			{
				seq: 0,
				name: 'sqlite_autoindex_run_logs_1',
				unique: true,
				origin: 'pk',
				partial: false,
			},
		],
		runLogsColumns: [
			{
				cid: 0,
				name: 'run_id',
				type: 'TEXT',
				notnull: true,
				dfltValue: null,
				pk: 1,
			},
		],
		tableCounts: {
			runs: 2,
			runLogs: 4,
			packageInvocationLedger: 0,
			workflowProjections: 1,
		},
		runCount: { meta: 2, actual: 2, matches: true },
		explainRunLogsDeleteByRunId: [
			{ id: 2, parent: 0, detail: 'SEARCH run_logs USING INTEGER PRIMARY KEY' },
		],
		explainRunLogsSelectByRunId: [
			{ id: 3, parent: 0, detail: 'SEARCH run_logs USING INTEGER PRIMARY KEY' },
		],
	}
}

function createCtx(roles: Array<'admin' | 'user'>) {
	return {
		env: { APP_DB: {} } as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(
					roles.includes('admin') ? adminStableUserId : targetStableUserId,
				),
				email: roles.includes('admin')
					? 'admin@example.com'
					: 'kent@example.com',
				displayName: 'Caller',
				roles,
			},
		}),
	}
}

test('adminRunLogSqlBilling is admin-only and returns content-free schema stats', async () => {
	const userCtx = createCtx(['user'])
	await expect(
		adminRunLogSqlBillingCapability.handler(
			{ username: 'kentcdodds' },
			userCtx,
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mockModule.inspectRunLogSqlBilling).not.toHaveBeenCalled()

	const ctx = createCtx(['admin'])
	mockModule.loadAdminUserByTarget.mockResolvedValueOnce(null)
	const missing = await adminRunLogSqlBillingCapability.handler(
		{ username: 'missing' },
		ctx,
	)
	expect(missing).toEqual({ report: null })
	expect(mockModule.inspectRunLogSqlBilling).not.toHaveBeenCalled()
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminRunLogSqlBilling',
			result: 'success',
			reason: 'user_not_found',
		}),
	)

	mockModule.loadAdminUserByTarget.mockResolvedValueOnce({
		stableUserId: targetStableUserId,
		username: 'kentcdodds',
		email: 'kent@example.com',
	})
	mockModule.inspectRunLogSqlBilling.mockResolvedValueOnce(inspectionFixture())
	const present = await adminRunLogSqlBillingCapability.handler(
		{ username: 'kentcdodds' },
		ctx,
	)
	expect(mockModule.loadAdminUserByTarget).toHaveBeenCalledWith(
		ctx.env.APP_DB,
		{
			username: 'kentcdodds',
		},
	)
	expect(mockModule.inspectRunLogSqlBilling).toHaveBeenCalledWith({
		env: ctx.env,
		userId: targetStableUserId,
	})
	expect(present.report?.stableUserId).toBe(targetStableUserId)
	expect(present.report?.username).toBe('kentcdodds')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminRunLogSqlBilling',
			result: 'success',
			reason: `target_stable_user_id=${targetStableUserId}`,
		}),
	)
	expect(JSON.stringify(present)).not.toContain('kent@example.com')
})
