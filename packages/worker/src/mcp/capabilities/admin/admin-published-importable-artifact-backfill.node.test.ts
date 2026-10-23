import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { adminPublishedImportableArtifactBackfillCapability } from './admin-published-importable-artifact-backfill.ts'

const mocks = vi.hoisted(() => ({
	runPublishedImportableArtifactBackfill: vi.fn(),
}))

vi.mock(
	'#worker/package-runtime/published-importable-artifact-backfill.ts',
	() => ({
		publishedImportableArtifactBackfillApplyLimitDefault: 5,
		publishedImportableArtifactBackfillApplyLimitMax: 10,
		publishedImportableArtifactBackfillScanLimitDefault: 50,
		publishedImportableArtifactBackfillScanLimitMax: 200,
		runPublishedImportableArtifactBackfill: (...args: Array<unknown>) =>
			mocks.runPublishedImportableArtifactBackfill(...args),
	}),
)

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

test('admin published importable artifact backfill enforces admin and defaults to dry-run', async () => {
	await expect(
		adminPublishedImportableArtifactBackfillCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runPublishedImportableArtifactBackfill).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mocks.runPublishedImportableArtifactBackfill.mockResolvedValue({
		dryRun: true,
		scannedPackages: 2,
		publishedPackages: 2,
		packagesNeedingRebuild: 1,
		missingImportableArtifacts: 3,
		packagesMissingSubpathImportable: 1,
		rebuiltPackages: 0,
		failedPackages: 0,
		alreadyBuiltPackages: 1,
		skippedUnpublished: 0,
		nextCursor: null,
		outcomes: [],
	})

	const result =
		await adminPublishedImportableArtifactBackfillCapability.handler(
			{},
			createContext(['admin']),
		)

	expect(mocks.runPublishedImportableArtifactBackfill).toHaveBeenCalledWith({
		env: expect.anything(),
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		afterId: null,
		limit: undefined,
		packageIds: undefined,
		ownerUserIds: undefined,
	})
	expect(result.packagesNeedingRebuild).toBe(1)
	expect(result.packagesMissingSubpathImportable).toBe(1)
	expect(auditEventSummaries()).toEqual([
		'mcp_capability_denied:failure',
		'adminPublishedImportableArtifactBackfill:success',
	])
})
