import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { storageSqlReadCeilingMessage } from '@kody-internal/shared/storage-sql-read-policy.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'

const mockModule = vi.hoisted(() => ({
	sqlQuery: vi.fn(),
	getSavedPackageById: vi.fn(),
	authorizePackageWrite: vi.fn(),
	assertStorageRunnerWriteWithinEntitlement: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	assertStorageRunnerWriteWithinEntitlement: (...args: Array<unknown>) =>
		mockModule.assertStorageRunnerWriteWithinEntitlement(...args),
	isReadOnlyStorageSqlQuery: (query: string) =>
		query.trim().toLowerCase().startsWith('select'),
	storageRunnerRpc: () => ({
		sqlQuery: mockModule.sqlQuery,
	}),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	estimateEntitlementStorageSqlWriteBytes: () => 0,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mockModule.getSavedPackageById,
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		authorizePackageWrite: mockModule.authorizePackageWrite,
	}
})

const { storageQueryCapability } = await import('./storage-query.ts')

function createCallerContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'User',
		},
	})
}

function createPackageCallerContext(packageId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		executionOrigin: 'background',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'User',
		},
		storageContext: {
			sessionId: null,
			appId: packageId,
			packageId,
			storageId: buildPackageStorageId(packageId),
		},
	})
}

test('storageQuery wraps Durable Object SQL caller mistakes and rethrows platform failures', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.authorizePackageWrite.mockResolvedValue(undefined)
	mockModule.sqlQuery.mockRejectedValueOnce(
		new Error('no such table: articles: SQLITE_ERROR'),
	)

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'storage-1',
				query: 'SELECT * FROM articles',
			},
			{
				env: {} as Env,
				callerContext: createCallerContext(),
			} as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'no such table: articles: SQLITE_ERROR',
	)

	// Extended Cloudflare suffix form (KODY-8P): "SQLITE_CONSTRAINT (extended: …)"
	mockModule.sqlQuery.mockRejectedValueOnce(
		new Error(
			'FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)',
		),
	)

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'storage-1',
				query: 'INSERT INTO probe_t (parent_id) VALUES (99)',
				writable: true,
			},
			{
				env: {} as Env,
				callerContext: createCallerContext(),
			} as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message ===
				'FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)',
	)

	const ceilingMessage = storageSqlReadCeilingMessage(1_000_000_001)
	mockModule.sqlQuery.mockRejectedValueOnce(new Error(ceilingMessage))

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'storage-1',
				query: 'SELECT * FROM huge',
			},
			{
				env: {} as Env,
				callerContext: createCallerContext(),
			} as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError && error.message === ceilingMessage,
	)

	const platformError = new Error(
		'Durable Object reset because its code was updated.',
	)
	mockModule.sqlQuery.mockRejectedValueOnce(platformError)

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'storage-1',
				query: 'SELECT 1',
			},
			{
				env: {} as Env,
				callerContext: createCallerContext(),
			} as never,
		),
	).rejects.toBe(platformError)
})

test('storageQuery denies package runtimes buckets their package does not own', async () => {
	const packageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
	const victimPackageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
	mockModule.sqlQuery.mockClear()

	await expect(
		storageQueryCapability.handler(
			{
				storage_id: buildPackageStorageId(victimPackageId),
				query: 'SELECT * FROM secrets',
			},
			{
				env: {} as Env,
				callerContext: createPackageCallerContext(packageId),
			} as never,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes(buildPackageStorageId(victimPackageId)),
	)
	expect(mockModule.sqlQuery).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce({
		id: packageId,
		userId: ownerIdFromStored('user-1'),
		name: '@user/pkg',
		kodyId: 'pkg',
	})
	mockModule.sqlQuery.mockResolvedValueOnce({
		columns: ['id'],
		rows: [{ id: 1 }],
		rowCount: 1,
		rowsRead: 1,
		rowsWritten: 0,
		truncated: false,
	})
	const ownBucketResult = await storageQueryCapability.handler(
		{
			storage_id: buildPackageStorageId(packageId),
			query: 'SELECT id FROM notes',
		},
		{
			env: {} as Env,
			callerContext: createPackageCallerContext(packageId),
		} as never,
	)
	expect(ownBucketResult.storage_id).toBe(buildPackageStorageId(packageId))
	expect(mockModule.authorizePackageWrite).toHaveBeenCalled()
})

test('writable storageQuery entitlements use the bound org, not the personal plan', async () => {
	const teamOrgId = ownerIdFromStored('org-acme')
	const packageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
	mockModule.getSavedPackageById.mockResolvedValue({
		id: packageId,
		userId: teamOrgId,
		name: '@acme/pkg',
		kodyId: 'pkg',
	})
	mockModule.authorizePackageWrite.mockResolvedValue(undefined)
	mockModule.assertStorageRunnerWriteWithinEntitlement.mockResolvedValue(
		undefined,
	)
	mockModule.sqlQuery.mockResolvedValue({
		columns: [],
		rows: [],
		rowCount: 0,
		rowsRead: 0,
		rowsWritten: 1,
		truncated: false,
	})

	await storageQueryCapability.handler(
		{
			storage_id: buildPackageStorageId(packageId),
			query: 'INSERT INTO notes (body) VALUES (?)',
			params: ['hello'],
			writable: true,
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				executionOrigin: 'background',
				user: {
					userId: personIdFromStored('user-1'),
					email: 'user@example.com',
					displayName: 'User',
				},
				orgBinding: {
					org: { id: teamOrgId, slug: 'acme' },
					// Owner compiles without APP_DB; the entitlement args are
					// what this regression asserts.
					role: 'owner',
				},
				storageContext: {
					sessionId: null,
					appId: packageId,
					packageId,
					storageId: buildPackageStorageId(packageId),
				},
			}),
		} as never,
	)

	expect(
		mockModule.assertStorageRunnerWriteWithinEntitlement,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: teamOrgId,
			email: null,
			storageId: buildPackageStorageId(packageId),
		}),
	)
})
