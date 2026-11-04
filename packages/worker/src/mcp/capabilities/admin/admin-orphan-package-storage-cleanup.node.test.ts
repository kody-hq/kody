import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { adminOrphanPackageStorageCleanupCapability } from './admin-orphan-package-storage-cleanup.ts'

const mocks = vi.hoisted(() => ({
	cleanupOrphanedPackageStorageBuckets: vi.fn(),
}))

vi.mock('#worker/package-registry/orphan-package-storage.ts', () => ({
	cleanupOrphanedPackageStorageBuckets:
		mocks.cleanupOrphanedPackageStorageBuckets,
	orphanedPackageStorageMaxLimit: 100,
}))

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('actor-1'),
				username: 'actor',
				email: 'actor@example.com',
				displayName: 'Actor',
				roles,
			},
		}),
	}
}

test('admin orphan package storage cleanup enforces admin role, previews by default, and applies only when asked', async () => {
	await expect(
		adminOrphanPackageStorageCleanupCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.cleanupOrphanedPackageStorageBuckets).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	const orphan = {
		userId: 'user-1',
		storageId: 'package:11111111-1111-4111-8111-111111111111',
		packageId: '11111111-1111-4111-8111-111111111111',
		estimatedBytes: 2048,
	}
	mocks.cleanupOrphanedPackageStorageBuckets.mockResolvedValueOnce({
		applied: false,
		clearedCount: 0,
		failedCount: 0,
		orphans: [orphan],
	})
	await adminOrphanPackageStorageCleanupCapability.handler(
		{},
		createContext(['admin']),
	)
	expect(mocks.cleanupOrphanedPackageStorageBuckets).toHaveBeenLastCalledWith({
		env: expect.anything(),
		apply: false,
		limit: undefined,
	})

	mocks.cleanupOrphanedPackageStorageBuckets.mockResolvedValueOnce({
		applied: true,
		clearedCount: 1,
		failedCount: 0,
		orphans: [orphan],
	})
	const result = await adminOrphanPackageStorageCleanupCapability.handler(
		{ apply: true, limit: 5 },
		createContext(['admin']),
	)
	expect(mocks.cleanupOrphanedPackageStorageBuckets).toHaveBeenLastCalledWith({
		env: expect.anything(),
		apply: true,
		limit: 5,
	})
	expect(result).toEqual({
		applied: true,
		cleared_count: 1,
		failed_count: 0,
		orphans: [
			{
				user_id: 'user-1',
				storage_id: orphan.storageId,
				package_id: orphan.packageId,
				estimated_bytes: 2048,
			},
		],
	})
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminOrphanPackageStorageCleanup:success',
		'adminOrphanPackageStorageCleanup:success',
	])
})
