import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	pendingApproval: null as {
		pendingCommit: string
		baseCommit: string | null
	} | null,
}))

vi.mock('#worker/package-capabilities/approval-requests-repo.ts', () => ({
	getPendingPackageApprovalRequest: async () => mockModule.pendingApproval,
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mockModule.publishFromExternalRef(...args),
	}),
}))

const { reconcileArtifactsPushes } =
	await import('#worker/jobs/reconcile-artifacts-pushes.ts')

test('reconcileArtifactsPushes skips plain repo entity_sources', async () => {
	const calls: Array<string> = []
	const env = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(..._params: Array<unknown>) {
						return {
							async all<T>() {
								if (query.includes('FROM entity_sources')) {
									calls.push('list')
									return {
										results: [
											{
												id: 'source-repo',
												user_id: ownerIdFromStored('user-1'),
												entity_kind: 'repo',
												entity_id: 'repo-1',
												repo_id: 'repo-repo-1',
												published_commit: null,
												indexed_commit: null,
												manifest_path: 'package.json',
												source_root: '/',
												last_external_check_at: null,
												external_check_until: null,
												created_at: '2026-01-01T00:00:00.000Z',
												updated_at: '2026-01-01T00:00:00.000Z',
											},
										],
									} as T
								}
								throw new Error(`Unexpected all: ${query}`)
							},
							async run() {
								if (query.includes('UPDATE entity_sources')) {
									calls.push('update')
								}
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env

	const result = await reconcileArtifactsPushes({
		env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-08-04T12:00:00.000Z'),
		batchSize: 10,
		staleAfterMinutes: 0,
		timeBudgetMs: 1000,
	})

	expect(result.checked).toBe(0)
	expect(calls).not.toContain('update')
})

test('reconcileArtifactsPushes skips locked packages without calling publish', async () => {
	const calls: Array<string> = []
	mockModule.publishFromExternalRef.mockReset()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	const env = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(..._params: Array<unknown>) {
						return {
							async all<T>() {
								if (query.includes('FROM entity_sources')) {
									calls.push('list')
									return {
										results: [
											{
												id: 'source-package',
												user_id: ownerIdFromStored('user-1'),
												entity_kind: 'package',
												entity_id: 'pkg-1',
												repo_id: 'repo-pkg-1',
												published_commit: 'commit-old',
												indexed_commit: null,
												manifest_path: 'package.json',
												source_root: '/',
												last_external_check_at: null,
												external_check_until: '2026-08-28T13:00:00.000Z',
												created_at: '2026-01-01T00:00:00.000Z',
												updated_at: '2026-01-01T00:00:00.000Z',
											},
										],
									} as T
								}
								throw new Error(`Unexpected all: ${query}`)
							},
							async first<T>() {
								if (query.includes('locked_at')) {
									calls.push('locked_at')
									return { locked_at: '2026-08-28T12:00:00.000Z' } as T
								}
								throw new Error(`Unexpected first: ${query}`)
							},
							async run() {
								if (query.includes('UPDATE entity_sources')) {
									calls.push('update')
								}
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env

	const result = await reconcileArtifactsPushes({
		env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-08-04T12:00:00.000Z'),
		batchSize: 10,
		staleAfterMinutes: 0,
		timeBudgetMs: 1000,
	})

	expect(result.checked).toBe(1)
	expect(result.lockedSkipped).toBe(1)
	expect(result.published).toBe(0)
	expect(calls).toContain('locked_at')
	expect(calls).toContain('update')
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})

test('reconcileArtifactsPushes waits on a pending credential-needs request only while its base is still published', async () => {
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	const env = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(..._params: Array<unknown>) {
						return {
							async all<T>() {
								if (query.includes('FROM entity_sources')) {
									return {
										results: [
											{
												id: 'source-package',
												user_id: ownerIdFromStored('user-1'),
												entity_kind: 'package',
												entity_id: 'pkg-1',
												repo_id: 'repo-pkg-1',
												published_commit: 'commit-codemod',
												indexed_commit: null,
												manifest_path: 'package.json',
												source_root: '/',
												last_external_check_at: null,
												external_check_until: '2026-08-28T13:00:00.000Z',
												created_at: '2026-01-01T00:00:00.000Z',
												updated_at: '2026-01-01T00:00:00.000Z',
											},
										],
									} as T
								}
								throw new Error(`Unexpected all: ${query}`)
							},
							async first<T>() {
								if (query.includes('locked_at')) {
									return { locked_at: null } as T
								}
								throw new Error(`Unexpected first: ${query}`)
							},
							async run() {
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env
	const reconcile = () =>
		reconcileArtifactsPushes({
			env,
			baseUrl: 'https://kody.test',
			now: new Date('2026-08-04T12:00:00.000Z'),
			batchSize: 10,
			staleAfterMinutes: 0,
			timeBudgetMs: 1000,
		})

	mockModule.publishFromExternalRef.mockReset()
	mockModule.pendingApproval = {
		pendingCommit: 'commit-new',
		baseCommit: 'commit-codemod',
	}
	expect((await reconcile()).approvalRequiredSkipped).toBe(1)
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()

	mockModule.pendingApproval = {
		pendingCommit: 'commit-new',
		baseCommit: 'commit-old',
	}
	mockModule.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-codemod',
		published_commit: 'commit-new',
	})
	expect((await reconcile()).approvalRequiredSkipped).toBe(0)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({ newCommit: 'commit-new' }),
	)
	mockModule.pendingApproval = null
})

function createPackageSourceEnv(input: {
	externalCheckFailedCommit?: string | null
	externalCheckFailedAt?: string | null
	updates: Array<Array<unknown>>
}) {
	return {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(...params: Array<unknown>) {
						return {
							async all<T>() {
								if (query.includes('FROM entity_sources')) {
									return {
										results: [
											{
												id: 'source-package',
												user_id: ownerIdFromStored('user-1'),
												entity_kind: 'package',
												entity_id: 'pkg-1',
												repo_id: 'repo-pkg-1',
												published_commit: 'commit-old',
												indexed_commit: null,
												manifest_path: 'package.json',
												source_root: '/',
												last_external_check_at: null,
												external_check_until: '2026-08-28T13:00:00.000Z',
												external_check_failed_commit:
													input.externalCheckFailedCommit ?? null,
												external_check_failed_at:
													input.externalCheckFailedAt ?? null,
												created_at: '2026-01-01T00:00:00.000Z',
												updated_at: '2026-01-01T00:00:00.000Z',
											},
										],
									} as T
								}
								throw new Error(`Unexpected all: ${query}`)
							},
							async first<T>() {
								if (query.includes('locked_at')) {
									return { locked_at: null } as T
								}
								throw new Error(`Unexpected first: ${query}`)
							},
							async run() {
								if (query.includes('UPDATE entity_sources')) {
									input.updates.push([query, ...params])
								}
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env
}

test('reconcileArtifactsPushes gives up on a source past its deadline and backs off that HEAD', async () => {
	mockModule.pendingApproval = null
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockReset()
	mockModule.publishFromExternalRef.mockReturnValue(new Promise(() => {}))
	consoleWarn.mockImplementation(() => {})
	const updates: Array<Array<unknown>> = []
	const startedAt = Date.now()
	const result = await reconcileArtifactsPushes({
		env: createPackageSourceEnv({ updates }),
		baseUrl: 'https://kody.test',
		now: new Date('2026-08-04T12:00:00.000Z'),
		batchSize: 10,
		staleAfterMinutes: 0,
		timeBudgetMs: 1000,
		sourceTimeoutMs: 20,
	})
	expect(Date.now() - startedAt).toBeLessThan(1000)
	expect(result.sourceTimeouts).toBe(1)
	expect(result.errors).toBe(0)
	expect(result.checksFailed).toBe(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'reconcile_artifacts_pushes source failed',
		expect.objectContaining({
			error: expect.stringContaining('deadline'),
		}),
	)
	// The timed-out HEAD is recorded like a checks_failed HEAD so the next
	// ticks skip it instead of starting the same publish every few minutes.
	// `external_check_until` stays so a newer push is still selected.
	expect(updates).toHaveLength(1)
	expect(String(updates[0]?.[0])).toContain('last_external_check_at = ?')
	expect(String(updates[0]?.[0])).toContain('external_check_failed_commit = ?')
	expect(updates[0]).toContain('commit-new')
	expect(String(updates[0]?.[0])).not.toContain('external_check_until')
})

test('reconcileArtifactsPushes skips publish concurrency races without counting errors', async () => {
	mockModule.pendingApproval = null
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockReset()
	mockModule.publishFromExternalRef.mockRejectedValueOnce(
		new Error(
			'The package\'s Artifacts HEAD moved from "commit-old" to "commit-new" while publishing. Retry the publish (or re-run so the newest pushed commit publishes).',
		),
	)
	consoleWarn.mockImplementation(() => {})
	const updates: Array<Array<unknown>> = []
	const result = await reconcileArtifactsPushes({
		env: createPackageSourceEnv({ updates }),
		baseUrl: 'https://kody.test',
		now: new Date('2026-08-04T12:00:00.000Z'),
		batchSize: 10,
		staleAfterMinutes: 0,
		timeBudgetMs: 1000,
	})
	expect(result.errors).toBe(0)
	expect(result.published).toBe(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'reconcile_artifacts_pushes publish concurrency race',
		expect.objectContaining({
			error: expect.stringContaining('Artifacts HEAD moved from'),
		}),
	)
	expect(updates).toHaveLength(1)
	expect(String(updates[0]?.[0])).toContain('last_external_check_at = ?')
})

test('reconcileArtifactsPushes remembers a failed head and skips re-checking it', async () => {
	mockModule.pendingApproval = null
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	const now = new Date('2026-08-04T12:00:00.000Z')
	const reconcile = (env: Env) =>
		reconcileArtifactsPushes({
			env,
			baseUrl: 'https://kody.test',
			now,
			batchSize: 10,
			staleAfterMinutes: 0,
			timeBudgetMs: 1000,
		})

	mockModule.publishFromExternalRef.mockReset()
	mockModule.publishFromExternalRef.mockResolvedValueOnce({
		status: 'checks_failed',
	})
	const failedUpdates: Array<Array<unknown>> = []
	expect(
		(await reconcile(createPackageSourceEnv({ updates: failedUpdates })))
			.checksFailed,
	).toBe(1)
	expect(String(failedUpdates[0]?.[0])).toContain(
		'external_check_failed_commit = ?',
	)
	expect(failedUpdates[0]).toContain('commit-new')

	mockModule.publishFromExternalRef.mockReset()
	const skipped = await reconcile(
		createPackageSourceEnv({
			updates: [],
			externalCheckFailedCommit: 'commit-new',
			externalCheckFailedAt: '2026-08-04T11:00:00.000Z',
		}),
	)
	expect(skipped.failedHeadSkipped).toBe(1)
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()

	// A different head runs checks again.
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-newer',
	})
	mockModule.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-newer',
	})
	const newHead = await reconcile(
		createPackageSourceEnv({
			updates: [],
			externalCheckFailedCommit: 'commit-new',
			externalCheckFailedAt: '2026-08-04T11:00:00.000Z',
		}),
	)
	expect(newHead.published).toBe(1)

	// So does the same head once the retry window has passed.
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValueOnce({
		status: 'checks_failed',
	})
	const retried = await reconcile(
		createPackageSourceEnv({
			updates: [],
			externalCheckFailedCommit: 'commit-new',
			externalCheckFailedAt: '2026-08-03T12:00:00.000Z',
		}),
	)
	expect(retried.failedHeadSkipped).toBe(0)
	expect(retried.checksFailed).toBe(1)
})
