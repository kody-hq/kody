import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as AuditLog from '#worker/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	runPackageCodemodStep: vi.fn(),
	getPackageCodemodRunById: vi.fn(),
	logAuditEvent: vi.fn(),
}))

vi.mock('#worker/package-codemods/engine.ts', () => ({
	runPackageCodemodStep: (...args: Array<unknown>) =>
		mockModule.runPackageCodemodStep(...args),
}))

vi.mock('#worker/package-codemods/ledger.ts', () => ({
	getPackageCodemodRunById: (...args: Array<unknown>) =>
		mockModule.getPackageCodemodRunById(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const { adminPackageCodemodApplyCapability } =
	await import('./admin-package-codemod-apply.ts')
const { adminPackageCodemodRevertCapability } =
	await import('./admin-package-codemod-revert.ts')
const { adminPackageCodemodScanCapability } =
	await import('./admin-package-codemod-scan.ts')
function createAdminCtx(userId = 'admin-1', roles: Array<string> = ['admin']) {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles,
			},
		}),
	}
}

const codemodId = '0001-ambient-storage-to-package-storage'

function stepResult(
	runId: string,
	mode: 'scan' | 'dry-run' | 'apply' | 'revert',
	nextCursor: string | null = null,
) {
	return { runId, codemodId, mode, items: [], nextCursor, summary: {} }
}

test('admin package codemod capabilities are fleet-scoped, audited, and role-gated', async () => {
	await expect(
		adminPackageCodemodScanCapability.handler(
			{ codemodId },
			createAdminCtx('user-1', ['user']),
		),
	).rejects.toThrow(/lacks required role/)

	mockModule.runPackageCodemodStep.mockResolvedValue(
		stepResult('fleet-scan-1', 'scan'),
	)

	await expect(
		adminPackageCodemodScanCapability.handler(
			{
				codemodId,
				filters: { userIds: ['user-a'], packageIds: ['pkg-a'] },
				limit: 5,
			},
			createAdminCtx(),
		),
	).resolves.toMatchObject({ runId: 'fleet-scan-1', mode: 'scan' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		baseUrl: 'https://heykody.dev',
		initiatedByUserId: 'admin-1',
		codemodId,
		mode: 'scan',
		scope: { kind: 'fleet' },
		filters: { userIds: ['user-a'], packageIds: ['pkg-a'] },
		runId: undefined,
		cursor: undefined,
		limit: 5,
		revertOfRunId: undefined,
	})
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminPackageCodemodScan',
			result: 'success',
		}),
	)

	mockModule.runPackageCodemodStep.mockResolvedValue(
		stepResult('fleet-apply-1', 'apply'),
	)
	await expect(
		adminPackageCodemodApplyCapability.handler(
			{
				codemodId,
				packageIds: ['pkg-canary'],
			},
			createAdminCtx(),
		),
	).resolves.toMatchObject({
		mode: 'apply',
		nextStep: 'This run has no further pages.',
	})
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith(
		expect.objectContaining({
			mode: 'apply',
			scope: { kind: 'fleet' },
			filters: { packageIds: ['pkg-canary'] },
			initiatedByUserId: 'admin-1',
		}),
	)
	mockModule.runPackageCodemodStep.mockResolvedValue(
		stepResult('fleet-apply-1', 'apply', 'cursor-2'),
	)
	await expect(
		adminPackageCodemodApplyCapability.handler(
			{
				codemodId,
				runId: 'fleet-apply-1',
				cursor: 'cursor-1',
			},
			createAdminCtx(),
		),
	).resolves.toMatchObject({
		mode: 'apply',
		nextCursor: 'cursor-2',
		nextStep:
			'This page is done. Continue in a new execute or workflows.create call with runId fleet-apply-1 and cursor cursor-2 (limit ≤5). Do not page again in the same sandbox.',
	})
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith(
		expect.objectContaining({
			mode: 'apply',
			scope: { kind: 'fleet' },
			runId: 'fleet-apply-1',
			cursor: 'cursor-1',
			initiatedByUserId: 'admin-1',
		}),
	)

	mockModule.getPackageCodemodRunById.mockResolvedValue({
		id: 'fleet-apply-1',
		codemodId,
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		filtersJson: '{}',
		status: 'completed',
		revertOfRunId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	})
	mockModule.runPackageCodemodStep.mockResolvedValue(
		stepResult('fleet-revert-1', 'revert'),
	)
	await expect(
		adminPackageCodemodRevertCapability.handler(
			{ revertOfRunId: 'fleet-apply-1' },
			createAdminCtx(),
		),
	).resolves.toMatchObject({ runId: 'fleet-revert-1', mode: 'revert' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith(
		expect.objectContaining({
			codemodId,
			mode: 'revert',
			scope: { kind: 'fleet' },
			revertOfRunId: 'fleet-apply-1',
		}),
	)
})
