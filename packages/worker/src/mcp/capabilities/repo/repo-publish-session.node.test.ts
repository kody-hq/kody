import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { buildPublishedPublishChecksKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as EntitySourcesModule from '#worker/repo/entity-sources.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'

const mockModule = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
	rebuildPublishedPackageArtifactsViaRepoSession: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	getRepoSessionById: vi.fn(),
	absorbCommunityForkUpstream: vi.fn(),
	getSavedPackageById: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

vi.mock('./package-artifact-rebuild.ts', () => ({
	rebuildPublishedPackageArtifactsViaRepoSession: (...args: Array<unknown>) =>
		mockModule.rebuildPublishedPackageArtifactsViaRepoSession(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', async (importOriginal) => ({
	...(await importOriginal<typeof EntitySourcesModule>()),
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getRepoSessionById: (...args: Array<unknown>) =>
		mockModule.getRepoSessionById(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	absorbCommunityForkUpstream: (...args: Array<unknown>) =>
		mockModule.absorbCommunityForkUpstream(...args),
}))

const { repoPublishSessionCapability } =
	await import('./repo-publish-session.ts')

function createCtx() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@test.invalid',
				displayName: 'User',
				username: 'user',
			},
			baseUrl: 'https://kody.test',
		}),
	}
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.getMcpUserPackageScope.mockResolvedValue('user')
	mockModule.rebuildPublishedPackageArtifactsViaRepoSession.mockResolvedValue(
		undefined,
	)
	mockModule.getRepoSessionById.mockResolvedValue({
		id: 'session-1',
		user_id: ownerIdFromStored('user-1'),
		source_id: 'source-1',
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
	})
	mockModule.absorbCommunityForkUpstream.mockResolvedValue(undefined)
	mockModule.repoSessionRpc.mockReturnValue({
		getSessionInfo: vi.fn(async () => ({
			entity_type: 'package',
			source_id: 'source-1',
		})),
		publishSession: vi.fn(async () => ({
			status: 'ok',
			sessionId: 'session-1',
			publishedCommit: 'commit-1',
			message: 'Published session to repo-artifacts-1.',
		})),
	})
}

test('repoPublishSession keeps a successful publish when fork absorb fails and stays quiet for self-authored packages', async () => {
	const published = {
		status: 'ok',
		session_id: 'session-1',
		published_commit: 'commit-1',
		message: 'Published session to repo-artifacts-1.',
	}
	const cases = [
		{
			absorbError: new Error('origin listing is gone'),
			expected: {
				...published,
				notice:
					'Published, but the behind-upstream banner did not clear: origin listing is gone. Retry repoPublishSession with absorbed_upstream_commit.',
			},
		},
		{
			absorbError: new CommunityActionError(
				'Package "demo" is self-authored and has no catalog entry to absorb.',
			),
			expected: published,
		},
	]
	for (const { absorbError, expected } of cases) {
		resetMocks()
		mockModule.absorbCommunityForkUpstream.mockRejectedValue(absorbError)

		const result = await repoPublishSessionCapability.handler(
			{ session_id: 'session-1', absorbed_upstream_commit: 'origin-head' },
			createCtx(),
		)

		expect(result).toEqual(expected)
		expect(mockModule.absorbCommunityForkUpstream).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: ownerIdFromStored('user-1'),
				packageId: 'package-1',
				originCommit: 'origin-head',
			}),
		)
	}
})

test('repoPublishSession keeps the credential notice on a locked publish', async () => {
	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'demo',
	})
	const credentialNotice =
		'Legacy credential patterns remain in src/index.ts (line 3).'
	mockModule.repoSessionRpc.mockReturnValue({
		getSessionInfo: vi.fn(async () => ({
			entity_type: 'package',
			source_id: 'source-1',
		})),
		publishSession: vi.fn(async () => ({
			status: 'locked',
			sessionId: 'session-1',
			publishedCommit: null,
			pendingCommit: 'commit-2',
			currentPublishedCommit: 'commit-1',
			packageId: 'package-1',
			packageName: '@user/demo',
			message: 'Package is locked.',
			credentialNotice,
		})),
	})

	const result = await repoPublishSessionCapability.handler(
		{ session_id: 'session-1' },
		createCtx(),
	)

	expect(result).toMatchObject({
		status: 'locked',
		pending_commit: 'commit-2',
	})
	expect(result.message).toMatch(/^Package "@user\/demo" is locked\./)
	expect(result.message).toContain(`\n\n${credentialNotice}`)
})

test('repoPublishSession reports a compute-limit reset as a caller error naming the limit', async () => {
	const { McpCallerError } = await import('#mcp/caller-error.ts')
	const rawReset = new Error(
		'Durable Object exceeded its CPU time limit and was reset.',
	)
	const alreadyNamed =
		'This publish exceeded a Kody compute limit during the credential stamp scan.'
	const runPublish = async (failure: Error) => {
		resetMocks()
		mockModule.repoSessionRpc.mockReturnValue({
			getSessionInfo: vi.fn(async () => ({
				entity_type: 'package',
				source_id: 'source-1',
			})),
			publishSession: vi.fn(async () => {
				throw failure
			}),
		})
		return repoPublishSessionCapability
			.handler({ session_id: 'session-1' }, createCtx())
			.catch((caught: unknown) => caught)
	}

	const remapped = await runPublish(rawReset)
	expect(remapped).toBeInstanceOf(McpCallerError)
	expect((remapped as Error).message).toContain('exceeded a Kody compute limit')
	expect((remapped as Error).message).not.toContain(rawReset.message)
	expect(
		mockModule.rebuildPublishedPackageArtifactsViaRepoSession,
	).not.toHaveBeenCalled()

	const passedThrough = await runPublish(new Error(alreadyNamed))
	expect(passedThrough).toBeInstanceOf(McpCallerError)
	expect((passedThrough as Error).message).toBe(alreadyNamed)
	expect(
		mockModule.rebuildPublishedPackageArtifactsViaRepoSession,
	).not.toHaveBeenCalled()
})

/**
 * RepoSession finalize moves published_commit, re-projects job pins, and
 * seals the tip before repoPublishSession rebuilds artifacts in a second
 * step. A failed rebuild must settle like packagePublishExternalPush does:
 * drop the seal and compare-and-set the pointer back to the session base,
 * never over a newer publish, while serving_commit stays on the last build.
 */
test('repoPublishSession rolls a failed artifact rebuild back to the session base', async () => {
	const ownerId = ownerIdFromStored('user-1')
	const runPublish = async (input: {
		sessionInfo: { base_commit: string; published_commit: string }
		concurrentPublishedCommit?: string
	}) => {
		resetMocks()
		const sqlite = new DatabaseSync(':memory:')
		sqlite.exec(entitySourcesTableSql)
		sqlite
			.prepare(
				`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, serving_commit, created_at, updated_at)
				VALUES ('source-1', ?, 'package', 'package-1', 'repo-1', ?, 'commit-old', '2026-11-01', '2026-11-01')`,
			)
			.run(ownerId, input.sessionInfo.published_commit)
		const setPublishedCommit = (commit: string) =>
			sqlite
				.prepare(
					`UPDATE entity_sources SET published_commit = ? WHERE id = 'source-1'`,
				)
				.run(commit)
		const { kv } = createMemoryKvNamespace()
		const sealKey = buildPublishedPublishChecksKvKey({
			sourceId: 'source-1',
			publishedCommit: 'commit-new',
		})
		mockModule.repoSessionRpc.mockReturnValue({
			getSessionInfo: vi.fn(async () => ({
				entity_type: 'package',
				source_id: 'source-1',
				...input.sessionInfo,
			})),
			// What RepoSession finalize leaves behind with
			// rebuildPackageArtifacts: false: pointer moved and tip sealed.
			publishSession: vi.fn(async () => {
				setPublishedCommit('commit-new')
				await kv.put(sealKey, JSON.stringify({ version: 1 }))
				return {
					status: 'ok',
					sessionId: 'session-1',
					publishedCommit: 'commit-new',
					message: 'Published session to repo-1.',
				}
			}),
		})
		mockModule.rebuildPublishedPackageArtifactsViaRepoSession.mockImplementation(
			async () => {
				if (input.concurrentPublishedCommit) {
					setPublishedCommit(input.concurrentPublishedCommit)
				}
				throw new Error(
					'Package source publish succeeded, but bundle artifact rebuild failed for source "source-1" at commit "commit-new".',
				)
			},
		)
		const ctx = createCtx()
		ctx.env = {
			APP_DB: createD1FromSqlite(sqlite),
			BUNDLE_ARTIFACTS_KV: kv,
		} as unknown as Env
		const error = await repoPublishSessionCapability
			.handler(
				{ session_id: 'session-1', absorbed_upstream_commit: 'origin-head' },
				ctx,
			)
			.then(
				() => null,
				(caught: unknown) => caught,
			)
		const row = sqlite
			.prepare(
				`SELECT published_commit, serving_commit FROM entity_sources WHERE id = 'source-1'`,
			)
			.get()
		return { error, row, sealed: (await kv.get(sealKey)) != null }
	}

	const failed = await runPublish({
		sessionInfo: { base_commit: 'commit-old', published_commit: 'commit-old' },
	})
	expect(failed.error).toBeInstanceOf(Error)
	expect((failed.error as Error).message).toMatch(
		/bundle artifact rebuild failed/,
	)
	expect((failed.error as Error).message).toMatch(/rolled back to "commit-old"/)
	expect(failed.row).toEqual({
		published_commit: 'commit-old',
		serving_commit: 'commit-old',
	})
	expect(failed.sealed).toBe(false)
	// Job pins and the package projection follow the restored pointer.
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerId,
			packageId: 'package-1',
			sourceId: 'source-1',
			rebuildArtifacts: false,
			audit: null,
		}),
	)
	expect(mockModule.absorbCommunityForkUpstream).not.toHaveBeenCalled()

	// A newer publish won the pointer while this rebuild ran: keep it, and
	// leave its projection to its own finalize.
	const raced = await runPublish({
		sessionInfo: { base_commit: 'commit-old', published_commit: 'commit-old' },
		concurrentPublishedCommit: 'commit-newer',
	})
	expect(raced.error).toBeInstanceOf(Error)
	expect(raced.row).toEqual({
		published_commit: 'commit-newer',
		serving_commit: 'commit-old',
	})
	expect(raced.sealed).toBe(false)
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	// A resumed publish (an interrupted attempt already moved the pointer to
	// the session HEAD) still restores the session base, the last good commit.
	const resumed = await runPublish({
		sessionInfo: { base_commit: 'commit-old', published_commit: 'commit-new' },
	})
	expect(resumed.row).toEqual({
		published_commit: 'commit-old',
		serving_commit: 'commit-old',
	})
	expect(resumed.sealed).toBe(false)
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledTimes(1)
})
