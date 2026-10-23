import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import type * as D1StorageReconciliation from '#worker/entitlements/d1-storage-reconciliation.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	d1StorageReconciliationBatchSize: 8,
	reconcileD1StorageBytes: vi.fn<
		typeof D1StorageReconciliation.reconcileD1StorageBytes
	>(async () => ({
		scanned: 2,
		updated: 1,
		failed: 1,
		deferred: 0,
	})),
	logAuditEvent: vi.fn<typeof AuditLog.logAuditEvent>(async () => ({
		persisted: false,
		failedSinks: [],
	})),
}))

vi.mock('#worker/entitlements/d1-storage-reconciliation.ts', () => ({
	d1StorageReconciliationBatchSize: mockModule.d1StorageReconciliationBatchSize,
	reconcileD1StorageBytes: (
		...args: Parameters<typeof D1StorageReconciliation.reconcileD1StorageBytes>
	) => mockModule.reconcileD1StorageBytes(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Parameters<typeof AuditLog.logAuditEvent>) =>
			mockModule.logAuditEvent(...args),
	}
})

const { adminUserMeterStorageReconcileCapability } =
	await import('./admin-user-meter-storage-reconcile.ts')

function createAdminContext(env: Env) {
	return {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
}

test('adminUserMeterStorageReconcile routes batch size, audits, and rejects OOB', async () => {
	mockModule.reconcileD1StorageBytes.mockResolvedValueOnce({
		scanned: 3,
		updated: 2,
		failed: 0,
		deferred: 1,
	})
	const env = { APP_DB: {} as D1Database, USER_METER: {} } as Env
	const ctx = createAdminContext(env)

	const custom = await adminUserMeterStorageReconcileCapability.handler(
		{ batch_size: 5 },
		ctx,
	)
	expect(custom.batchSize).toBe(5)
	expect(custom.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminUserMeterStorageReconcile',
			result: 'success',
		}),
	)

	mockModule.reconcileD1StorageBytes.mockResolvedValueOnce({
		scanned: 5,
		updated: 4,
		failed: 1,
		deferred: 0,
	})
	const defaults = await adminUserMeterStorageReconcileCapability.handler(
		{},
		ctx,
	)
	expect(defaults.batchSize).toBe(mockModule.d1StorageReconciliationBatchSize)

	mockModule.reconcileD1StorageBytes.mockClear()
	await expect(
		adminUserMeterStorageReconcileCapability.handler({ batch_size: 0 }, ctx),
	).rejects.toBeInstanceOf(McpCallerError)
	await expect(
		adminUserMeterStorageReconcileCapability.handler({ batch_size: 9 }, ctx),
	).rejects.toBeInstanceOf(McpCallerError)
	expect(mockModule.reconcileD1StorageBytes).not.toHaveBeenCalled()
})
