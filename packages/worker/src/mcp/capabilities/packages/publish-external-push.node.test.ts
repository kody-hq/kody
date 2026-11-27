import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as PublishedRuntimeArtifactsModule from '#worker/package-runtime/published-runtime-artifacts.ts'

import type { advanceServingCommit } from '#worker/package-capabilities/serving-commit-advance.ts'

// These fixtures have no owner or package rows, so no profile package exists.
vi.mock('#worker/package-app-profile-host.ts', () => ({
	hasProfilePackageApp: async () => false,
}))

vi.mock('#worker/package-capabilities/serving-commit-advance.ts', async () => {
	const { advanceEntitySourceServingCommit } =
		await import('#worker/repo/entity-sources.ts')
	return {
		advanceServingCommit: (input: Parameters<typeof advanceServingCommit>[0]) =>
			advanceEntitySourceServingCommit(input.env.APP_DB, {
				id: input.sourceId,
				userId: input.userId,
				commit: input.commit,
			}),
	}
})

const mockModule = vi.hoisted(() => ({
	notePackageAppPublishRequester: vi.fn(async (_input: unknown) => {}),
	loadHeldForApproval: vi.fn(
		async (..._args: Array<unknown>): Promise<unknown> => null,
	),
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	takeLastCheckStep: vi.fn(async (): Promise<unknown> => null),
	getLinkedPublishArtifactSizes: vi.fn(),
	listPublishedPackageArtifactTargets: vi.fn(),
	persistUploadedPublishBuild: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
	getStaticPackageDependentsSummary: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	dispatchDurableRun: vi.fn(),
	listPublisherEnablementGaps: vi.fn(),
	clearPublishedPublishChecksVersion: vi.fn(
		async (..._args: Array<unknown>) => {},
	),
	revertEntitySourcePublishedCommit: vi.fn(
		async (..._args: Array<unknown>): Promise<string | null> => 'commit-old',
	),
	refreshSavedPackageProjection: vi.fn(async (..._args: Array<unknown>) => {}),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock(
	'#worker/package-runtime/published-runtime-artifacts.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof PublishedRuntimeArtifactsModule>()),
		clearPublishedPublishChecksVersion: (...args: Array<unknown>) =>
			mockModule.clearPublishedPublishChecksVersion(...args),
	}),
)

vi.mock('#worker/package-capabilities/held-for-approval.ts', () => ({
	loadHeldForApproval: (...args: Array<unknown>) =>
		mockModule.loadHeldForApproval(...args),
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
	advanceEntitySourceServingCommit: async () => true,
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
	revertEntitySourcePublishedCommit: (...args: Array<unknown>) =>
		mockModule.revertEntitySourcePublishedCommit(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: async (...args: Array<unknown>) => {
			const result = await mockModule.publishFromExternalRef(...args)
			if (result?.status === 'published' && result.published_commit) {
				mockModule.getEntitySourceByIdForUser.mockResolvedValue(
					sourceRow(result.published_commit),
				)
			}
			return result
		},
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		persistUploadedPublishBuild: (...args: Array<unknown>) =>
			mockModule.persistUploadedPublishBuild(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
		takeLastCheckStep: () => mockModule.takeLastCheckStep(),
		getLinkedPublishArtifactSizes: (...args: Array<unknown>) =>
			mockModule.getLinkedPublishArtifactSizes(...args),
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

vi.mock('#worker/package-runtime/package-app-authority.ts', () => ({
	notePackageAppPublishRequester: (input: unknown) =>
		mockModule.notePackageAppPublishRequester(input),
}))

vi.mock('#mcp/capabilities/durable-escalation.ts', () => ({
	defaultDurableEscalationBudgetMs: 35_000,
	buildCallerScopedIdempotencyKey: (input: {
		userId: string
		parts: ReadonlyArray<string>
	}) => [input.userId, ...input.parts].join(':'),
	dispatchDurableRun: (...args: Array<unknown>) =>
		mockModule.dispatchDurableRun(...args),
}))

const { publishExternalPushCapability } =
	await import('./publish-external-push.ts')

const defaultPublishIdempotencyParts = [
	'packagePublishExternalPush',
	'v3',
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
		serving_commit: publishedCommit,
		held_commit: null,
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
	mockModule.loadHeldForApproval.mockResolvedValue(null)
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
	mockModule.dispatchDurableRun.mockResolvedValue({
		kind: 'dispatched',
		handle: dispatchedHandle,
	})
}

const dispatchedHandle = {
	status: 'dispatched',
	workflow_id: 'dynwf-publish-1',
	workflow_name: 'packagePublishExternalPush',
	idempotency_key: 'user-1:packagePublishExternalPush',
	run_status: 'queued',
	message: 'dispatched',
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

/**
 * A publish as its durable run executes it: the workflow step re-enters the
 * capability in the background with the baseline stamped at dispatch. That
 * is the only place a publish runs. Pass `interactive` for the caller's
 * request, which only dispatches.
 */
function publish(
	args: {
		allow_force?: boolean
		confirm_destructive_overwrite?: boolean
		baseline_published_commit?: string | null
		expected_head?: string
	} = {},
	executionOrigin: 'interactive' | 'background' | 'omit' = 'background',
) {
	return publishExternalPushCapability.handler(
		{
			package_id: 'package-1',
			...(executionOrigin === 'background'
				? { baseline_published_commit: 'commit-old' }
				: {}),
			...args,
		},
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
			hosted_app_url: 'https://demo-package--user.packages.kody.test/',
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

test('a publish that renames the package links the app at its new name', async () => {
	setupDefaultMocks({ hasApp: true })
	const savedPackage = {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		kodyId: 'old-name',
		name: '@user/old-name',
		sourceId: 'source-1',
		hasApp: true,
	}
	let renamed = false
	mockModule.getSavedPackageById.mockImplementation(async () =>
		renamed
			? { ...savedPackage, kodyId: 'new-name', name: '@user/new-name' }
			: savedPackage,
	)
	// The publish refreshes the saved package from the new package.json name.
	mockModule.publishFromExternalRef.mockImplementation(async () => {
		renamed = true
		return publishedResult({
			manifest: {
				name: '@user/new-name',
				kody: { app: { entry: './app.ts' } },
			},
		})
	})

	const result = await publish()

	expect(result.status).toBe('published')
	expect(result).toEqual(
		expect.objectContaining({
			hosted_app_url: 'https://new-name--user.packages.kody.test/',
		}),
	)
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

test('a publish held for capability approval reports held_for_approval, never published', async () => {
	setupDefaultMocks({ hasApp: true, publish: publishedResult() })
	const servingCommit = 'approved0deadbeef'
	const heldCommit = 'heldnew1cafebabe'
	mockModule.loadHeldForApproval.mockResolvedValue({
		servingCommit,
		heldCommit,
	})

	const notice = await publish()
	expect(notice.status).toBe('held_for_approval')
	if (notice.status !== 'held_for_approval') throw new Error('expected held')
	expect(notice).toMatchObject({
		serving_commit: servingCommit,
		held_commit: heldCommit,
	})
	expect(notice).not.toHaveProperty('published_commit')
	const approval = new URL(notice.approval_url)
	expect(approval.origin).toBe('https://kody.test')
	expect(approval.pathname).toBe('/@user/demo-package/approve-capabilities')
	expect(notice.message).toContain(servingCommit.slice(0, 7))
	expect(notice.message).toContain(heldCommit.slice(0, 7))
	expect(notice.message).toContain(notice.approval_url)
	expect(mockModule.loadHeldForApproval).toHaveBeenCalledWith({
		env: expect.anything(),
		packageId: 'package-1',
		ownerUserId: ownerIdFromStored('user-1'),
	})
})

test('publishing a commit that is already held again still reports held_for_approval', async () => {
	setupDefaultMocks({
		head: 'commit-old',
		hasApp: true,
		publish: { status: 'already_published', published_commit: 'commit-old' },
	})
	mockModule.loadHeldForApproval.mockResolvedValue({
		servingCommit: 'commit-approved',
		heldCommit: 'commit-old',
	})

	const result = await publish()
	expect(result).toMatchObject({
		status: 'held_for_approval',
		serving_commit: 'commit-approved',
		held_commit: 'commit-old',
		approval_url: 'https://kody.test/@user/demo-package/approve-capabilities',
	})
	expect(result).not.toHaveProperty('published_commit')
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
		hosted_app_url: 'https://demo-package--user.packages.kody.test/',
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
	})
	// The failed rebuild is not a successful publish: drop the tip's seal so
	// retrying the same commit re-runs checks instead of a sealed no-op.
	expect(mockModule.clearPublishedPublishChecksVersion).toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'commit-new' }),
	)
	// The pointer, projection, and job pins go back to the last good commit.
	expect(mockModule.revertEntitySourcePublishedCommit).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			failedCommit: 'commit-new',
		}),
	)
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId: 'package-1',
			sourceId: 'source-1',
			rebuildArtifacts: false,
			audit: null,
		}),
	)

	// A rebuild that hits the isolate CPU limit is terminal too: the publish
	// stops, and the pointer and job pins still go back to the last good commit.
	setupDefaultMocks({ publish: publishedResult(), targets: [moduleTarget] })
	mockModule.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
		new Error('Durable Object exceeded its CPU time limit and was reset.'),
	)
	await expect(publish()).rejects.toThrow(/memory or CPU limit/)
	expect(mockModule.revertEntitySourcePublishedCommit).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			failedCommit: 'commit-new',
		}),
	)
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({ sourceId: 'source-1', rebuildArtifacts: false }),
	)

	setupDefaultMocks({
		head: 'commit-old',
		publish: alreadyPublishedOld,
		targets: [moduleTarget],
	})
	mockModule.revertEntitySourcePublishedCommit.mockResolvedValueOnce(null)
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
	})
	expect(mockModule.clearPublishedPublishChecksVersion).toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'commit-old' }),
	)
	// The already serving commit stayed in place.
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()
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

test('a publish that fails its checks returns the structured result from the run', async () => {
	const checksFailed = {
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'type error' }],
		manifest: {},
		run_id: 'run-1',
	}
	setupDefaultMocks({ publish: checksFailed })

	// The RepoSession check-attempt id is not a runGet run, so it is dropped.
	const { run_id: _checkAttemptId, ...expected } = checksFailed
	expect(await publish()).toEqual(expected)
	expect(mockModule.dispatchDurableRun).not.toHaveBeenCalled()
})

test('a caller request always dispatches and never runs the publish, whatever its origin', async () => {
	for (const origin of ['interactive', 'omit'] as const) {
		setupDefaultMocks({ publish: publishedResult() })
		expect((await publish({}, origin)).status).toBe('dispatched')
		expect(mockModule.dispatchDurableRun).toHaveBeenCalledTimes(1)
		expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
	}
	// A background caller that is not the run's own step (no stamped
	// baseline) dispatches too.
	setupDefaultMocks({ publish: publishedResult() })
	const nested = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext('background'),
	)
	expect(nested.status).toBe('dispatched')
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})

test('an interactive publish returns the dispatched handle with the baseline stamped for the run', async () => {
	setupDefaultMocks()
	const handle = {
		status: 'dispatched',
		workflow_id: 'dynwf-publish-1',
		workflow_name: 'packagePublishExternalPush',
		idempotency_key: ['user-1', ...defaultPublishIdempotencyParts].join(':'),
		run_status: 'queued',
		message: 'dispatched',
	}
	mockModule.dispatchDurableRun.mockResolvedValue({
		kind: 'dispatched',
		handle,
	})

	expect(await publish({}, 'interactive')).toEqual({
		...handle,
		phase_timings: { total_ms: expect.any(Number) },
	})
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
	expect(mockModule.dispatchDurableRun).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			idempotencyParts: defaultPublishIdempotencyParts,
			durableParams: expect.objectContaining({
				baseline_published_commit: 'commit-old',
			}),
			// Publishing a finished commit again runs again (artifact repair).
			rerunComplete: true,
		}),
	)
	// The durable run finishes as the org, so the person who asked is noted.
	expect(mockModule.notePackageAppPublishRequester).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: { orgId: ownerIdFromStored('user-1'), packageId: 'package-1' },
			personId: personIdFromStored('user-1'),
			commit: expect.any(String),
		}),
	)
})

test('durable re-entry rejects a Git HEAD different from the enqueued commit', async () => {
	setupDefaultMocks({ head: 'commit-newer' })

	await expect(
		publish(
			{ baseline_published_commit: 'commit-old', expected_head: 'commit-new' },
			'background',
		),
	).rejects.toThrow(/Artifacts HEAD moved from "commit-new" to "commit-newer"/)
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})

test('an external publish superseded during artifact rebuild cannot report success', async () => {
	setupDefaultMocks({ publish: publishedResult(), targets: [moduleTarget] })
	mockModule.rebuildPublishedPackageArtifact.mockImplementationOnce(
		async () => {
			mockModule.getEntitySourceByIdForUser.mockResolvedValue(
				sourceRow('commit-newer'),
			)
			return { ok: true, target: moduleTarget, kvKey: 'bundle-key' }
		},
	)

	await expect(publish()).rejects.toThrow(
		/published commit moved while this publish was running/,
	)
	expect(mockModule.revertEntitySourcePublishedCommit).not.toHaveBeenCalled()
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
	expect(mockModule.dispatchDurableRun).not.toHaveBeenCalled()
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

	// Interactive callers must not spoof baseline (null would force published):
	// the run is stamped with the tip the request actually saw.
	setupDefaultMocks({
		head: 'commit-old',
		publish: {
			status: 'already_published',
			published_commit: 'commit-old',
		},
	})
	expect(
		(await publish({ baseline_published_commit: null }, 'interactive')).status,
	).toBe('dispatched')
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
	expect(mockModule.dispatchDurableRun).toHaveBeenCalledWith(
		expect.objectContaining({
			durableParams: expect.objectContaining({
				baseline_published_commit: 'commit-old',
			}),
		}),
	)
})

test('durable re-entry finalizes an uploaded build without the upload bucket binding', async () => {
	setupDefaultMocks({
		publish: { status: 'already_published', published_commit: 'commit-new' },
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		sourceRow('commit-new'),
	)
	mockModule.persistUploadedPublishBuild.mockResolvedValue({
		ok: true,
		targetCount: 2,
	})

	const ctx = createContext('background')
	const prepare = ctx.env.APP_DB.prepare
	vi.spyOn(ctx.env.APP_DB, 'prepare').mockImplementation((sql) => {
		let row: unknown
		if (sql.includes('FROM publish_builds')) {
			row = {
				id: 'pb_demo',
				package_id: 'package-1',
				source_id: 'source-1',
				requester_user_id: 'user-1',
				commit_sha: 'commit-new',
				status: 'sealed',
				document_sha256: 'a'.repeat(64),
				origin: 'cli',
				context_name: null,
			}
		} else if (sql.includes('SELECT id FROM users')) {
			row = { id: 1 }
		} else if (sql.includes('FROM feature_flag_user_overrides')) {
			row = { enabled: 1 }
		} else if (
			sql.includes('FROM feature_flags') ||
			sql.includes('FROM feature_flag_org_overrides')
		) {
			row = null
		} else if (sql.includes('experiments_opt_in')) {
			row = { experiments_opt_in: 0 }
		} else {
			return prepare(sql)
		}
		return {
			bind: () => ({
				first: async () => row,
				all: async () => ({ results: row ? [row] : [] }),
			}),
		} as unknown as D1PreparedStatement
	})
	// The publish-offload flag is read as one batch.
	ctx.env.APP_DB.batch = (async (
		statements: Array<{ all: () => Promise<unknown> }>,
	) =>
		await Promise.all(
			statements.map((statement) => statement.all()),
		)) as unknown as D1Database['batch']

	const result = await publishExternalPushCapability.handler(
		{
			package_id: 'package-1',
			baseline_published_commit: 'commit-old',
			publish_build_id: 'pb_demo',
		},
		ctx,
	)

	expect(result).toMatchObject({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		build_origin: { origin: 'cli' },
	})
	expect(mockModule.persistUploadedPublishBuild).toHaveBeenCalledWith({
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-new',
		buildId: 'pb_demo',
		diagnosticsId: expect.any(String),
		baseUrl: 'https://kody.test',
	})
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	mockModule.persistUploadedPublishBuild.mockRejectedValueOnce(
		new TypeError("Cannot read properties of undefined (reading 'get')"),
	)
	await expect(
		publishExternalPushCapability.handler(
			{
				package_id: 'package-1',
				baseline_published_commit: 'commit-old',
				publish_build_id: 'pb_demo',
			},
			ctx,
		),
	).rejects.toThrow(
		"Failed while finalizing the uploaded build: Cannot read properties of undefined (reading 'get')",
	)

	mockModule.persistUploadedPublishBuild.mockRejectedValueOnce(
		new Error('Durable Object exceeded its CPU time limit and was reset'),
	)
	mockModule.getLinkedPublishArtifactSizes.mockResolvedValueOnce({
		count: 2,
		largest: [
			{ path: 'kody:@example/books/list', bytes: 400_000 },
			{ path: 'kody:@example/books/position', bytes: 350_000 },
		],
	})
	await expect(
		publishExternalPushCapability.handler(
			{
				package_id: 'package-1',
				baseline_published_commit: 'commit-old',
				publish_build_id: 'pb_demo',
			},
			ctx,
		),
	).rejects.toSatisfy((error: Error) => {
		expect(error.message).toContain('Finalization still runs on Kody')
		expect(error.message).toContain('`kody:@example/books/list` (391 KiB)')
		expect(error.message).toContain('`kody:@example/books/position` (342 KiB)')
		expect(error.message).not.toContain('--build local')
		return true
	})
	expect(mockModule.getLinkedPublishArtifactSizes).toHaveBeenCalledWith(
		mockModule.persistUploadedPublishBuild.mock.lastCall?.[0].diagnosticsId,
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
	mockModule.dispatchDurableRun.mockResolvedValue({
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
	expect(mockModule.dispatchDurableRun).toHaveBeenCalledWith(
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
			new Error('Durable Object reset because its code was updated.'),
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
			new Error('Durable Object reset because its code was updated.'),
		)
		.mockImplementationOnce(async () => {
			mockModule.getEntitySourceByIdForUser.mockResolvedValue(
				sourceRow('commit-new'),
			)
			return {
				status: 'already_published',
				published_commit: 'commit-new',
			}
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
		new Error('Durable Object reset because its code was updated.'),
	)
	await expect(publish()).rejects.toThrow(
		/could not recover after 3 transient Durable Object reset attempts/,
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(3)
	expect(consoleWarn).toHaveBeenCalledTimes(3)

	const { McpCallerError } = await import('#mcp/caller-error.ts')
	// A tree near the memory/CPU limit fails most attempts: fail fast with an
	// actionable caller error instead of burning ~35s of retries.
	for (const message of [
		"Durable Object's isolate exceeded its memory limit and was reset",
		'Durable Object exceeded its CPU time limit and was reset',
	]) {
		setupDefaultMocks()
		consoleWarn.mockClear()
		mockModule.publishFromExternalRef.mockRejectedValue(new Error(message))
		await expect(publish()).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(McpCallerError)
			expect((error as Error).message).toContain(
				'stopped instead of retrying the same limit',
			)
			return true
		})
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
		expect(consoleWarn).not.toHaveBeenCalled()
	}

	// The reset isolate recorded which step it was on; the error names it.
	setupDefaultMocks()
	mockModule.publishFromExternalRef.mockRejectedValue(
		new Error(
			"Durable Object's isolate exceeded its memory limit and was reset",
		),
	)
	mockModule.takeLastCheckStep.mockResolvedValueOnce('credentials')
	await expect(publish()).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(McpCallerError)
		const message = (error as Error).message
		expect(message).toContain('during the credential stamp scan')
		expect(message).toContain('kody dev check')
		return true
	})

	// Deploy-time DO resets use "Durable Object reset because…" (no "was").
	// The old substring matcher missed that form and skipped retries entirely.
	for (const [message, cause] of [
		[
			'rebuild target failed',
			'Durable Object storage operation exceeded timeout which caused object to be reset.',
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

test('a durable publish run fails for any outcome that did not publish', async () => {
	const { durablePublishRefusalReason } =
		await import('#worker/package-runtime/durable-publish-result.ts')
	expect(
		durablePublishRefusalReason({
			status: 'published',
			published_commit: 'commit-new',
		}),
	).toBeNull()
	expect(
		durablePublishRefusalReason({
			status: 'already_published',
			published_commit: 'c',
		}),
	).toBeNull()
	expect(
		durablePublishRefusalReason({
			status: 'checks_failed',
			failed_checks: [
				{ kind: 'typecheck', ok: true, message: 'fine' },
				{ kind: 'bundle', ok: false, message: 'ran out of memory' },
			],
			manifest: null,
		}),
	).toBe(
		'packagePublishExternalPush returned checks_failed: bundle: ran out of memory',
	)
	expect(
		durablePublishRefusalReason({
			status: 'not_fast_forward',
			message: 'not a descendant',
		}),
	).toBe(
		'packagePublishExternalPush returned not_fast_forward: not a descendant',
	)
	// A held publish is built but not live, so its run does not end a success.
	expect(
		durablePublishRefusalReason({
			status: 'held_for_approval',
			serving_commit: 'a',
			held_commit: 'b',
			approval_url: 'https://kody.test/@user/demo/approve-capabilities',
			message:
				'This publish is held for approval and is not live. The owner approves it here: https://kody.test/@user/demo/approve-capabilities',
		}),
	).toBe(
		'packagePublishExternalPush returned held_for_approval: This publish is held for approval and is not live. The owner approves it here: https://kody.test/@user/demo/approve-capabilities',
	)
	// A locked package pauses before publish starts: a different status.
	expect(
		durablePublishRefusalReason({
			status: 'approval_required',
			message: 'Owner approval required.',
		}),
	).toBe(
		'packagePublishExternalPush returned approval_required: Owner approval required.',
	)
	expect(durablePublishRefusalReason(null)).toBe(
		'packagePublishExternalPush returned null',
	)
})

test('an uploaded build is checked against the person who made it, not the org a durable re-entry runs as', async () => {
	const { publishRequesterPersonId } =
		await import('./publish-external-push.ts')
	expect(
		publishRequesterPersonId({
			user: { userId: 'org-kody' },
			request: { actor: { userId: 'person-kent' } },
		} as never),
	).toBe('person-kent')
	expect(
		publishRequesterPersonId({
			user: { userId: 'person-solo' },
			request: null,
		} as never),
	).toBe('person-solo')
})
