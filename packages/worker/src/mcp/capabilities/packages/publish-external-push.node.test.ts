import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	listPublishedPackageArtifactTargets: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
	getStaticPackageDependentsSummary: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	runWithDurableEscalation: vi.fn(),
	listPublisherEnablementGaps: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/enablements/publisher-enablement-gaps.ts', () => ({
	listPublisherEnablementGaps: (...args: Array<unknown>) =>
		mockModule.listPublisherEnablementGaps(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mockModule.publishFromExternalRef(...args),
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

vi.mock('#worker/package-runtime/static-package-dependents.ts', () => ({
	getStaticPackageDependentsSummary: (...args: Array<unknown>) =>
		mockModule.getStaticPackageDependentsSummary(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/package-runtime/published-bundle-artifacts.ts')
	>('#worker/package-runtime/published-bundle-artifacts.ts')
	return {
		...actual,
		isPublishedPackageArtifactBuiltForCommit: (...args: Array<unknown>) =>
			mockModule.isPublishedPackageArtifactBuiltForCommit(...args),
	}
})

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: async () => {
		throw new Error('published source unavailable in unit test')
	},
}))

vi.mock('#mcp/capabilities/durable-escalation.ts', () => ({
	defaultDurableEscalationBudgetMs: 35_000,
	buildCallerScopedIdempotencyKey: (input: {
		userId: string
		parts: ReadonlyArray<string>
	}) => [input.userId, ...input.parts].join(':'),
	runWithDurableEscalation: (...args: Array<unknown>) =>
		mockModule.runWithDurableEscalation(...args),
}))

const { publishExternalPushCapability } =
	await import('./publish-external-push.ts')

const defaultPublishIdempotencyParts = [
	'packagePublishExternalPush',
	'{"allowForce":false,"destructiveOverwriteConfirmed":false,"newCommit":"commit-new","ownerUserId":"user-1","packageId":"package-1"}',
]
const moduleTarget = {
	kind: 'module',
	artifactName: '.',
	entryPoint: 'src/index.ts',
	bundleKind: 'module',
}
const allPhaseTimings = {
	rebuild_ms: expect.any(Number),
	dependents_ms: expect.any(Number),
	total_ms: expect.any(Number),
}
const noStaticDependents = expect.objectContaining({
	total: 0,
	stale: 0,
	truncated: false,
	items: [],
})

function sourceRow(publishedCommit = 'commit-old') {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
	}
}

function publishedResult(overrides: Record<string, unknown> = {}) {
	return {
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: {},
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
		...overrides,
	}
}

function rebuildCall(publishedCommit: string, target: unknown) {
	return {
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		publishedCommit,
		target,
		baseUrl: 'https://kody.test',
	}
}

function setupDefaultMocks({
	head = 'commit-new',
	hasApp = false,
	publish,
	targets = [],
}: {
	head?: string
	hasApp?: boolean
	publish?: Record<string, unknown>
	targets?: Array<unknown>
} = {}) {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.listPublisherEnablementGaps.mockResolvedValue([])
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		kodyId: 'demo-package',
		name: '@kentcdodds/demo-package',
		sourceId: 'source-1',
		hasApp,
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(sourceRow())
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: head,
	})
	if (publish) mockModule.publishFromExternalRef.mockResolvedValue(publish)
	mockModule.getStaticPackageDependentsSummary.mockResolvedValue({
		total: 0,
		stale: 0,
		truncated: false,
		items: [],
		recommended_next_action:
			'No published bundle artifacts declare a static dependency on this package.',
	})
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)
	mockModule.rebuildPublishedPackageArtifact.mockResolvedValue({
		ok: true,
		target: moduleTarget,
		kvKey: 'bundle-key',
	})
	mockModule.runWithDurableEscalation.mockImplementation(
		async (input: { run: (signal: AbortSignal) => Promise<unknown> }) => {
			const value = await input.run(new AbortController().signal)
			return { kind: 'completed', value }
		},
	)
}

function createContext(
	executionOrigin: 'interactive' | 'background' | 'omit' = 'interactive',
) {
	return {
		env: {
			APP_DB: {
				prepare: () => ({
					bind: () => ({ first: async () => ({ username: 'user' }) }),
				}),
			},
			DYNAMIC_CALLABLE_WORKFLOWS: {},
			PACKAGE_APP_BASE_URL: 'https://packages.kody.test',
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.test',
			executionOrigin: executionOrigin === 'omit' ? undefined : executionOrigin,
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				username: 'user',
				displayName: 'User',
			},
		}),
	}
}

function publish(
	args: {
		allow_force?: boolean
		confirm_destructive_overwrite?: boolean
		baseline_published_commit?: string | null
	} = {},
	executionOrigin?: 'interactive' | 'background' | 'omit',
) {
	return publishExternalPushCapability.handler(
		{ package_id: 'package-1', ...args },
		createContext(executionOrigin),
	)
}

test('publishExternalPush publishes HEAD and rebuilds bundle artifacts per target', async () => {
	setupDefaultMocks({
		publish: publishedResult({
			manifest: {
				kody: {
					app: { entry: './src/app.ts' },
					subscriptions: {
						'email.message.received': { handler: './src/on-email.ts' },
					},
				},
			},
		}),
	})
	mockModule.listPublisherEnablementGaps.mockResolvedValue([
		{ kind: 'cron', name: 'inbox-refresh', reason: 'missing' },
	])

	const publishedFirst = await publish()

	expect(publishedFirst.status).toBe('published')
	expect(publishedFirst).toEqual(
		expect.objectContaining({
			phase_timings: allPhaseTimings,
			hosted_app_url: 'https://user.packages.kody.test/packages/demo-package',
			test_hints: {
				app: expect.stringContaining('package_id'),
				subscriptions: [
					expect.objectContaining({ topic: 'email.message.received' }),
				],
				enablements: {
					message: expect.stringContaining(
						'Enable missing triggers as follows',
					),
					triggers: [
						{
							kind: 'cron',
							name: 'inbox-refresh',
							reason: 'missing',
							call: 'enablementEnable({ packageId: "package-1", triggerKind: "cron", triggerName: "inbox-refresh" })',
						},
					],
				},
			},
			static_dependents: expect.objectContaining({ total: 0, items: [] }),
		}),
	)
	expect(publishedFirst).not.toHaveProperty('listing')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			newCommit: 'commit-new',
			expectedHead: 'commit-new',
			allowForce: false,
			rebuildPackageArtifacts: false,
			expectedPackageScope: 'user',
			deferBundleCheckToRebuild: true,
		}),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalledTimes(1)

	const targets = [
		moduleTarget,
		{
			...moduleTarget,
			kind: 'importable-module',
			bundleKind: 'importable-module',
		},
	]
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)

	expect((await publish()).status).toBe('published')
	expect(mockModule.listPublishedPackageArtifactTargets).toHaveBeenCalledWith({
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
	})
	expect(mockModule.rebuildPublishedPackageArtifact.mock.calls).toEqual([
		[rebuildCall('commit-new', targets[0])],
		[rebuildCall('commit-new', targets[1])],
	])
})

test('publishExternalPush includes listing hint when the public catalog pin lags the promoted commit', async () => {
	setupDefaultMocks({
		publish: publishedResult({
			manifest: { version: '1.5.0', name: '@user/demo-package' },
		}),
	})
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'commit-old',
		version: '1.4.0',
	})

	const published = await publish()
	expect(published.status).toBe('published')
	if (published.status !== 'published') throw new Error('expected published')
	expect(published.listing).toEqual({
		pinnedVersion: '1.4.0',
		promotedVersion: '1.5.0',
		behind: true,
		updateHint: expect.stringContaining('automatically'),
		updateUrl:
			'https://kody.test/@user/demo-package/settings#update-public-listing',
	})
})

test('publishExternalPush still succeeds when listing hint lookup rejects', async () => {
	consoleWarn.mockImplementation(() => {})
	setupDefaultMocks({
		publish: publishedResult({
			manifest: { version: '1.5.0', name: '@user/demo-package' },
		}),
	})
	mockModule.getCommunityListingByOwnerAndPackage.mockRejectedValue(
		new Error('D1 unavailable'),
	)

	const published = await publish()
	expect(published.status).toBe('published')
	if (published.status !== 'published') throw new Error('expected published')
	expect(published.listing).toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('listing-behind-hint'),
		'D1 unavailable',
	)
})

test('publishExternalPush returns forwarded clone and check timings without collapsing bundle and rebuild', async () => {
	setupDefaultMocks({
		publish: publishedResult({
			phase_timings: {
				clone_ms: 11,
				checks_typecheck_ms: 22,
				checks_bundle_ms: 33,
			},
		}),
	})
	const published = await publish()
	expect(published.status).toBe('published')
	if (published.status !== 'published') throw new Error('expected published')
	expect(published.phase_timings).toEqual({
		clone_ms: 11,
		checks_typecheck_ms: 22,
		checks_bundle_ms: 33,
		...allPhaseTimings,
	})
	expect(
		Object.values(published.phase_timings).filter(
			(ms) => typeof ms !== 'number' || ms < 0,
		),
	).toEqual([])

	setupDefaultMocks({
		publish: publishedResult({
			checks: [
				{
					kind: 'bundle',
					ok: true,
					message: 'Bundle validation deferred to published artifact rebuild.',
				},
			],
			phase_timings: { clone_ms: 11, checks_typecheck_ms: 22 },
		}),
	})
	const deferredBundle = await publish()
	expect(deferredBundle.status).toBe('published')
	if (deferredBundle.status !== 'published') {
		throw new Error('expected published')
	}
	expect(deferredBundle.phase_timings).toEqual({
		clone_ms: 11,
		checks_typecheck_ms: 22,
		...allPhaseTimings,
	})
	expect(deferredBundle.phase_timings.checks_bundle_ms).toBeUndefined()
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			rebuildPackageArtifacts: false,
			deferBundleCheckToRebuild: true,
		}),
	)

	setupDefaultMocks({
		head: 'commit-old',
		publish: {
			status: 'already_published',
			published_commit: 'commit-old',
			phase_timings: { clone_ms: 7 },
		},
	})
	const alreadyPublished = await publish()
	expect(alreadyPublished).toEqual(
		expect.objectContaining({
			status: 'already_published',
			published_commit: 'commit-old',
			// Default module target is reused/skipped in this fixture; timings
			// still include rebuild_ms even when no target needed a rebuild.
			artifacts_rebuilt: false,
			phase_timings: { clone_ms: 7, ...allPhaseTimings },
		}),
	)
	if (alreadyPublished.status !== 'already_published') {
		throw new Error('expected already_published')
	}
	expect(alreadyPublished.phase_timings.checks_typecheck_ms).toBeUndefined()
	expect(alreadyPublished.phase_timings.checks_bundle_ms).toBeUndefined()
})

test('publishExternalPush handles already_published branches, stale dependents, and rebuild failures', async () => {
	const jobTarget = {
		kind: 'job',
		artifactName: 'inbox',
		entryPoint: 'src/job.ts',
		bundleKind: 'module',
	}
	const alreadyPublishedOld = {
		status: 'already_published',
		published_commit: 'commit-old',
	}
	setupDefaultMocks({
		head: 'commit-old',
		hasApp: true,
		publish: alreadyPublishedOld,
		targets: [jobTarget],
	})
	expect(await publish()).toEqual({
		status: 'already_published',
		published_commit: 'commit-old',
		artifacts_rebuilt: true,
		hosted_app_url: 'https://user.packages.kody.test/packages/demo-package',
		static_dependents: noStaticDependents,
		pending_secret_package_approvals: null,
		allowed_packages_publish_notice: null,
		phase_timings: allPhaseTimings,
	})
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith(
		rebuildCall('commit-old', jobTarget),
	)
	for (const phase of ['"phase":"rebuild"', '"phase":"dependents"']) {
		expect(
			consoleInfo.mock.calls.some((call) => String(call[0]).includes(phase)),
		).toBe(true)
	}

	setupDefaultMocks({
		head: 'commit-old',
		publish: alreadyPublishedOld,
		targets: [jobTarget],
	})
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(true)
	const skippedRebuild = await publish()
	expect(skippedRebuild).toEqual(
		expect.objectContaining({
			status: 'already_published',
			artifacts_rebuilt: false,
		}),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	setupDefaultMocks({
		head: 'commit-old',
		publish: { ...alreadyPublishedOld, force_artifact_rebuild: true },
		targets: [jobTarget],
	})
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(true)
	const forcedRebuild = await publish()
	expect(forcedRebuild).toEqual(
		expect.objectContaining({
			status: 'already_published',
			artifacts_rebuilt: true,
		}),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith(
		rebuildCall('commit-old', jobTarget),
	)

	setupDefaultMocks({
		head: 'commit-old',
		publish: { status: 'already_published', published_commit: null },
	})
	await expect(publish()).rejects.toThrow(
		'already published, but no published commit is available to rebuild artifacts',
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	setupDefaultMocks({ publish: publishedResult() })
	mockModule.getStaticPackageDependentsSummary.mockResolvedValue({
		total: 1,
		stale: 1,
		truncated: false,
		items: [
			{
				package_id: 'package-b',
				kody_id: 'package-b',
				name: '@kentcdodds/package-b',
				source_id: 'source-b',
				published_commit: 'commit-b',
				stale: true,
				artifact_count: 1,
				entrypoints: ['src/index.ts'],
				entrypoints_truncated: false,
				bundled_dependency_commit: 'commit-a-old',
				current_dependency_commit: 'commit-new',
				recommended_action: 'Inspect this dependent package.',
			},
		],
		recommended_next_action: 'Inspect stale static dependents.',
	})
	expect(await publish()).toEqual(
		expect.objectContaining({
			status: 'published',
			static_dependents: expect.objectContaining({
				total: 1,
				stale: 1,
				items: [
					expect.objectContaining({
						package_id: 'package-b',
						stale: true,
						bundled_dependency_commit: 'commit-a-old',
						current_dependency_commit: 'commit-new',
					}),
				],
			}),
		}),
	)

	setupDefaultMocks({ publish: publishedResult(), targets: [moduleTarget] })
	mockModule.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
		new Error('No matching default export for import "default"'),
	)
	expect(await publish()).toEqual({
		status: 'checks_failed',
		failed_checks: [
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringMatching(/bundle artifact rebuild failed/i),
			}),
		],
		manifest: {},
		run_id: expect.any(String),
	})

	setupDefaultMocks({
		head: 'commit-old',
		publish: alreadyPublishedOld,
		targets: [moduleTarget],
	})
	mockModule.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
		new Error('No matching default export for import "default"'),
	)
	expect(await publish()).toEqual({
		status: 'checks_failed',
		failed_checks: [
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringMatching(/bundle artifact rebuild failed/i),
			}),
		],
		manifest: null,
		run_id: expect.any(String),
	})
})

test('force publish passes destructive confirmation through and refuses without allow_force', async () => {
	setupDefaultMocks({
		head: 'commit-rewrite',
		publish: {
			status: 'not_fast_forward',
			previous_commit: 'commit-old',
			published_commit: 'commit-rewrite',
			message: 'The external Artifacts HEAD is not a descendant.',
		},
	})
	expect((await publish()).status).toBe('not_fast_forward')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({ allowForce: false }),
	)
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalled()

	mockModule.publishFromExternalRef.mockResolvedValue(
		publishedResult({ published_commit: 'commit-rewrite', checks: [] }),
	)
	await publish({ allow_force: true, confirm_destructive_overwrite: true })
	expect(mockModule.publishFromExternalRef).toHaveBeenLastCalledWith(
		expect.objectContaining({
			allowForce: true,
			destructiveOverwriteConfirmed: true,
		}),
	)
})

test('ineligible publishes return structured results without durable escalation dispatch', async () => {
	const checksFailed = {
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'type error' }],
		manifest: {},
		run_id: 'run-1',
	}
	setupDefaultMocks({ publish: checksFailed })

	expect(await publish()).toEqual(checksFailed)
	// RunLog workflow projections are scoped by acting userId; parts keep full
	// semantic input.
	expect(mockModule.runWithDurableEscalation.mock.calls).toEqual([
		[
			expect.objectContaining({
				userId: ownerIdFromStored('user-1'),
				idempotencyParts: defaultPublishIdempotencyParts,
			}),
		],
	])
})

test('missing executionOrigin fails closed and background re-entry skips escalation', async () => {
	for (const origin of ['omit', 'background'] as const) {
		setupDefaultMocks({ publish: publishedResult() })
		expect((await publish({}, origin)).status).toBe('published')
		expect(mockModule.runWithDurableEscalation).not.toHaveBeenCalled()
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
	}
})

test('budget exhaustion returns a dispatched handle', async () => {
	setupDefaultMocks()
	const handle = {
		status: 'dispatched',
		workflow_id: 'dynwf-publish-1',
		workflow_name: 'packagePublishExternalPush',
		idempotency_key: ['user-1', ...defaultPublishIdempotencyParts].join(':'),
		run_status: 'queued',
		message: 'dispatched',
	}
	mockModule.runWithDurableEscalation.mockResolvedValue({
		kind: 'dispatched',
		handle,
	})

	expect(await publish({}, 'interactive')).toEqual({
		...handle,
		phase_timings: { total_ms: expect.any(Number) },
	})
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			idempotencyParts: defaultPublishIdempotencyParts,
			durableParams: expect.objectContaining({
				baseline_published_commit: 'commit-old',
			}),
		}),
	)
})

test('durable re-entry remaps RepoSession already_published to published when tip moved vs baseline', async () => {
	// Single-attempt dispatched path: overlapping inline work advanced the tip,
	// then durable re-entry sees tip==HEAD. Status must still be published.
	setupDefaultMocks({
		head: 'commit-new',
		publish: {
			status: 'already_published',
			published_commit: 'commit-new',
			phase_timings: { clone_ms: 3 },
		},
		targets: [moduleTarget],
	})
	// Tip in D1 already matches HEAD (as after the overlapping inline promote).
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		sourceRow('commit-new'),
	)

	const remapped = await publish(
		{ baseline_published_commit: 'commit-old' },
		'background',
	)
	expect(remapped).toEqual({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: null,
		checks: [],
		hosted_app_url: null,
		static_dependents: noStaticDependents,
		pending_secret_package_approvals: null,
		allowed_packages_publish_notice: null,
		phase_timings: { clone_ms: 3, ...allPhaseTimings },
	})
	expect(mockModule.runWithDurableEscalation).not.toHaveBeenCalled()
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith(
		rebuildCall('commit-new', moduleTarget),
	)

	// True no-op: tip already matched HEAD before the request.
	setupDefaultMocks({
		head: 'commit-old',
		publish: {
			status: 'already_published',
			published_commit: 'commit-old',
		},
	})
	expect(
		await publish({ baseline_published_commit: 'commit-old' }, 'background'),
	).toEqual(
		expect.objectContaining({
			status: 'already_published',
			published_commit: 'commit-old',
			artifacts_rebuilt: false,
		}),
	)

	// Interactive callers must not spoof baseline (null would force published).
	setupDefaultMocks({
		head: 'commit-old',
		publish: {
			status: 'already_published',
			published_commit: 'commit-old',
		},
	})
	expect(
		await publish({ baseline_published_commit: null }, 'interactive'),
	).toEqual(
		expect.objectContaining({
			status: 'already_published',
			published_commit: 'commit-old',
			artifacts_rebuilt: false,
		}),
	)
})

test('durable escalation keys team-org publishes to the owning org, not the actor personal org', async () => {
	const teamOrgId = ownerIdFromStored('org-kody')
	setupDefaultMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: teamOrgId,
		kodyId: 'agent-mail',
		name: '@kody/agent-mail',
		sourceId: 'source-1',
		hasApp: false,
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		...sourceRow(),
		user_id: teamOrgId,
	})
	mockModule.runWithDurableEscalation.mockResolvedValue({
		kind: 'dispatched',
		handle: {
			status: 'dispatched',
			workflow_id: 'dynwf-team-1',
			workflow_name: 'packagePublishExternalPush',
			idempotency_key: 'org-kody:publish',
			run_status: 'queued',
			message: 'dispatched',
		},
	})

	const ctx = {
		env: {
			APP_DB: {
				prepare: () => ({
					bind: () => ({ first: async () => ({ username: 'patch' }) }),
				}),
			},
			DYNAMIC_CALLABLE_WORKFLOWS: {},
			PACKAGE_APP_BASE_URL: 'https://packages.kody.test',
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.test',
			executionOrigin: 'interactive',
			user: {
				userId: personIdFromStored('actor-1'),
				email: 'patch@example.com',
				username: 'patch',
				displayName: 'Patch',
			},
			orgBinding: {
				org: { id: teamOrgId, slug: 'kody' },
				role: 'owner',
			},
		}),
	}

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		ctx,
	)
	expect(result.status).toBe('dispatched')
	expect(mockModule.runWithDurableEscalation).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: teamOrgId,
		}),
	)
})

test('publishExternalPush recovers from transient Durable Object resets', async () => {
	consoleWarn.mockImplementation(() => {})
	setupDefaultMocks()
	mockModule.publishFromExternalRef
		.mockRejectedValueOnce(
			new Error('Durable Object exceeded its CPU time limit and was reset'),
		)
		.mockResolvedValueOnce(publishedResult())

	expect((await publish()).status).toBe('published')
	expect(mockModule.publishFromExternalRef.mock.calls).toEqual([
		[expect.objectContaining({ sessionId: 'external-publish-source-1' })],
		[
			expect.objectContaining({
				sessionId: 'external-publish-source-1-retry-2',
			}),
		],
	])
	// Each transient reset leaves exactly one retry warn trail (no Sentry).
	expect(consoleWarn).toHaveBeenCalledTimes(1)

	setupDefaultMocks()
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		sourceRow('commit-old'),
	)
	mockModule.publishFromExternalRef
		.mockRejectedValueOnce(
			new Error(
				"Durable Object's isolate exceeded its memory limit and was reset",
			),
		)
		.mockResolvedValueOnce({
			status: 'already_published',
			published_commit: 'commit-new',
		})
	// Tip advanced during the failed attempt; remap to published vs pre-request tip.
	expect(await publish()).toEqual({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: null,
		checks: [],
		hosted_app_url: null,
		static_dependents: noStaticDependents,
		pending_secret_package_approvals: null,
		allowed_packages_publish_notice: null,
		phase_timings: allPhaseTimings,
	})

	setupDefaultMocks()
	consoleWarn.mockClear()
	mockModule.publishFromExternalRef.mockRejectedValue(
		new Error('Durable Object exceeded its CPU time limit and was reset'),
	)
	await expect(publish()).rejects.toThrow(
		/could not recover after 3 transient Durable Object reset attempts/,
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(3)
	expect(consoleWarn).toHaveBeenCalledTimes(3)

	// Deploy-time DO resets use "Durable Object reset because…" (no "was").
	// The old substring matcher missed that form and skipped retries entirely.
	for (const [message, cause] of [
		[
			'rebuild target failed',
			'Durable Object exceeded its CPU time limit and was reset.',
		],
		[
			'Package source publish succeeded, but bundle artifact rebuild failed.',
			'Durable Object reset because its code was updated.',
		],
	]) {
		setupDefaultMocks({ publish: publishedResult(), targets: [moduleTarget] })
		consoleWarn.mockClear()
		mockModule.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
			new Error(message, { cause: new Error(cause) }),
		)
		expect((await publish()).status).toBe('published')
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
		expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
		expect(consoleWarn).toHaveBeenCalledTimes(1)
	}
})

test('publishExternalPush returns locked with pending_commit and an approval URL', async () => {
	setupDefaultMocks({
		publish: {
			status: 'locked',
			previous_commit: 'commit-old',
			pending_commit: 'commit-new',
			message: 'Package "@kentcdodds/demo-package" is locked.',
			packageId: 'package-1',
			packageName: '@kentcdodds/demo-package',
		},
	})

	expect(await publish()).toEqual({
		status: 'locked',
		previous_commit: 'commit-old',
		pending_commit: 'commit-new',
		approval_url:
			'https://kody.test/@user/demo-package/approve-publish?commit=commit-new',
		message:
			'Package "@kentcdodds/demo-package" is locked. Publishes require approval at https://kody.test/@user/demo-package/approve-publish?commit=commit-new.',
	})
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()
})
