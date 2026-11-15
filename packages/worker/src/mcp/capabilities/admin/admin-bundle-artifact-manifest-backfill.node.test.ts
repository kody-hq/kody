import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminBundleArtifactManifestBackfillCapability } from './admin-bundle-artifact-manifest-backfill.ts'

const mocks = vi.hoisted(() => ({
	runBundleArtifactManifestBackfill: vi.fn(),
}))

vi.mock('#worker/package-runtime/bundle-artifact-manifest-backfill.ts', () => ({
	bundleArtifactManifestBackfillLimitDefault: 25,
	bundleArtifactManifestBackfillLimitMax: 100,
	runBundleArtifactManifestBackfill: (...args: Array<unknown>) =>
		mocks.runBundleArtifactManifestBackfill(...args),
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

test('the manifest backfill is admin only and writes nothing unless dryRun is false', async () => {
	await expect(
		adminBundleArtifactManifestBackfillCapability.handler(
			{},
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.runBundleArtifactManifestBackfill).not.toHaveBeenCalled()

	mocks.runBundleArtifactManifestBackfill.mockResolvedValue({
		dryRun: true,
		scannedRows: 0,
		filledRows: 0,
		manifestsWritten: 0,
		unbackfillableRows: 0,
		readFailedRows: 0,
		nextCursor: null,
		problems: [],
	})
	await adminBundleArtifactManifestBackfillCapability.handler(
		{ userIds: ['user-1'] },
		createContext(['admin']),
	)
	expect(mocks.runBundleArtifactManifestBackfill).toHaveBeenLastCalledWith(
		expect.objectContaining({
			dryRun: true,
			afterId: null,
			userIds: ['user-1'],
		}),
	)

	await adminBundleArtifactManifestBackfillCapability.handler(
		{ dryRun: false, cursor: 'row-9' },
		createContext(['admin']),
	)
	expect(mocks.runBundleArtifactManifestBackfill).toHaveBeenLastCalledWith(
		expect.objectContaining({ dryRun: false, afterId: 'row-9' }),
	)
})
