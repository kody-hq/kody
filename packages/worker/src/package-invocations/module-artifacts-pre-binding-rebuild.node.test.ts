import { addInProcessExecuteBundleIsolates } from '#worker/test-support/execute-bundle-isolates.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	createBundleArtifactsKv,
	createDatabase,
	createJobServiceTestEnv,
	insertPublishedEntitySource,
	resetJobServiceMocks,
} from '#worker/test-support/jobs-service.ts'
import {
	ensureModuleArtifact,
	isTransientModuleArtifactError,
	runIsolatedModuleArtifactRebuild,
	type IsolatedModuleArtifactRebuildRequest,
} from './module-artifacts.ts'
import {
	runWithBoundPermissions,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'

vi.mock('#worker/repo/source-service.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).sourceServiceMock(),
)
vi.mock('#worker/repo/source-sync.ts', async () =>
	(await import('#worker/test-support/jobs-service-mocks.ts')).sourceSyncMock(),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).artifactRepoCleanupMock(),
)
vi.mock('#worker/repo/repo-sessions.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionsMock(),
)
vi.mock('#worker/repo/repo-session-do.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionDoMock(),
)
vi.mock('#worker/worker-bundler-modules.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).workerBundlerModulesMock(),
)

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- restores the shared job-service mocks between tests.
afterEach(() => {
	resetJobServiceMocks()
})

const userId = ownerIdFromStored('user-123')

function createSavedPackage(suffix: string): SavedPackageRecord {
	return {
		id: `pkg-${suffix}`,
		userId,
		name: `@kody/${suffix}`,
		kodyId: suffix,
		description: 'Pre-binding module bundle test',
		tags: [],
		searchText: null,
		sourceId: `source-${suffix}`,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-10-20T00:00:00.000Z',
		updatedAt: '2026-10-20T00:00:00.000Z',
	}
}

/**
 * Stores a module bundle the way publish did before GHSA-5fv3: it inlines
 * another package, has no lexical package binding, and carries no binding
 * marker. Workflow export steps, webhooks, email handlers, subscriptions, and
 * plain export calls all load this artifact through `ensureModuleArtifact`.
 */
async function seedPreBindingModuleBundle(input: {
	suffix: string
	manifest: Record<string, unknown>
	/**
	 * Stored main-module body. Defaults to a free-fetch pre-binding shape.
	 * Pass a packageStorage-only body to cover marker-missing bundles the
	 * free-fetch heuristic alone would have kept serving.
	 */
	bundledEntry?: string
	/** Stands in for the rebuild isolate, for example to make it reset. */
	rebuildIsolate?: (
		env: Env,
		request: IsolatedModuleArtifactRebuildRequest,
	) => Promise<unknown>
}) {
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	const env = createJobServiceTestEnv({
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	})
	const { isolateNames } = addInProcessExecuteBundleIsolates(
		env,
		undefined,
		input.rebuildIsolate
			? (request) => input.rebuildIsolate!(env, request)
			: undefined,
	)
	const savedPackage = createSavedPackage(input.suffix)
	await insertPublishedEntitySource({
		db,
		userId,
		sourceId: savedPackage.sourceId,
		entityKind: 'package',
		entityId: savedPackage.id,
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		kv: bundleKv,
		files: {
			'package.json': JSON.stringify(input.manifest),
			'src/nightly.ts': 'export default async () => ({ version: "source" })',
		},
	})
	const source = await getEntitySourceById(db, savedPackage.sourceId)
	if (!source) throw new Error('Expected source row.')
	const bundledEntry =
		input.bundledEntry ??
		'export default async () => { await fetch("https://example.com/"); return { version: "pre-binding-bundle" } }'
	const kvKey = await persistPublishedBundleArtifact({
		env: { APP_DB: db, BUNDLE_ARTIFACTS_KV: bundleKv } as Env,
		userId,
		source,
		kind: 'module',
		artifactName: './nightly',
		entryPoint: 'src/nightly.ts',
		mainModule: 'dist/bundled-entry.js',
		modules: {
			'dist/bundled-entry.js': bundledEntry,
		},
		dependencies: [
			{
				sourceId: 'source-dependency',
				publishedCommit: 'dependency-commit',
				kodyId: 'dependency',
				packageId: 'pkg-dependency',
			},
		],
		packageContext: {
			packageId: savedPackage.id,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
		},
	})
	if (!kvKey) throw new Error('Expected stored module bundle.')
	const stored = (await bundleKv.get(kvKey, 'json')) as Record<string, unknown>
	delete stored.packageBindingRewrite
	await bundleKv.put(kvKey, JSON.stringify(stored))
	return { env, savedPackage, isolateNames }
}

test('a pre-binding module bundle that inlines another package rebuilds before a workflow export step runs it', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env, savedPackage, isolateNames } = await seedPreBindingModuleBundle({
		suffix: 'pre-binding-workflow',
		manifest: {
			name: '@kody/pre-binding-workflow',
			exports: { './nightly': './src/nightly.ts' },
			kody: { id: 'pre-binding-workflow', description: 'Nightly workflow' },
		},
	})

	const { artifact } = await ensureModuleArtifact({
		env,
		baseUrl: 'https://kody.dev',
		savedPackage,
		selector: { kind: 'export', exportName: 'nightly' },
		userId,
	})

	const modules = Object.values(artifact.modules).join('\n')
	expect(modules).toContain('userEntrypoint')
	expect(modules).not.toContain('pre-binding-bundle')
	// The rebuild ran in its own org-namespaced throwaway isolate.
	expect(isolateNames).toHaveLength(1)
	expect(isolateNames[0]).toMatch(
		new RegExp(`^isolated-module-artifact-rebuild-${userId}-`),
	)
})

const nightlyManifest = (id: string) => ({
	name: `@kody/${id}`,
	exports: { './nightly': './src/nightly.ts' },
	kody: { id, description: 'Nightly workflow' },
})

test('a rebuild that exceeds its isolate fails only that run and says to publish again', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env, savedPackage } = await seedPreBindingModuleBundle({
		suffix: 'rebuild-reset',
		manifest: nightlyManifest('rebuild-reset'),
		rebuildIsolate: async () => {
			throw new Error(durableObjectIsolateMemoryResetMessage)
		},
	})

	const error = await ensureModuleArtifact({
		env,
		baseUrl: 'https://kody.dev',
		savedPackage,
		selector: { kind: 'export', exportName: 'nightly' },
		userId,
	}).catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(Error)
	const message = (error as Error).message
	expect(message).toContain(
		"exceeded the isolated rebuild runner's memory or CPU limits",
	)
	expect(message).toContain('kody package publish --build local')
	// Retrying cannot help, so the run must not be retried as artifact prep.
	expect(isTransientModuleArtifactError(error)).toBe(false)
})

test('a rebuild failure keeps its cause chain and caller-error class across the isolate boundary', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env, savedPackage } = await seedPreBindingModuleBundle({
		suffix: 'rebuild-causes',
		manifest: nightlyManifest('rebuild-causes'),
		rebuildIsolate: async () => {
			return {
				ok: false,
				name: 'McpCallerError',
				messages: [
					'Could not store the bundle.',
					'D1_ERROR: database is locked',
				],
				callerError: true,
			}
		},
	})

	const error = await ensureModuleArtifact({
		env,
		baseUrl: 'https://kody.dev',
		savedPackage,
		selector: { kind: 'export', exportName: 'nightly' },
		userId,
	}).catch((caught: unknown) => caught)

	expect(isMcpCallerError(error)).toBe(true)
	expect((error as Error).message).toBe('Could not store the bundle.')
	expect(((error as Error).cause as Error).message).toBe(
		'D1_ERROR: database is locked',
	)
	expect(isTransientModuleArtifactError(error)).toBe(true)
})

test('a rebuild runs under the permissions its caller was bound to', async () => {
	silenceIncidentalRuntimeWarnings()
	const received: Array<EffectivePermissions | undefined> = []
	const { env, savedPackage } = await seedPreBindingModuleBundle({
		suffix: 'rebuild-permissions',
		manifest: nightlyManifest('rebuild-permissions'),
		rebuildIsolate: async (isolateEnv, request) => {
			received.push(request.permissions)
			return await runIsolatedModuleArtifactRebuild(isolateEnv, request)
		},
	})
	const access: EffectivePermissions = {
		orgId: userId,
		permissions: new Set<OrgPermission>(['package:execute']),
		isOwner: false,
		resourcePermissions: new Map([
			[
				`package:${savedPackage.id}`,
				new Set<OrgPermission>(['package:execute']),
			],
		]),
		credentialScopes: null,
	}

	await runWithBoundPermissions(access, () =>
		ensureModuleArtifact({
			env,
			baseUrl: 'https://kody.dev',
			savedPackage,
			selector: { kind: 'export', exportName: 'nightly' },
			userId,
		}),
	)

	expect(received).toEqual([access])
})

test('a packageStorage-only multi-package module bundle without a binding marker rebuilds for workflow export steps', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env, savedPackage } = await seedPreBindingModuleBundle({
		suffix: 'pre-binding-storage-workflow',
		manifest: {
			name: '@kody/pre-binding-storage-workflow',
			exports: { './nightly': './src/nightly.ts' },
			kody: {
				id: 'pre-binding-storage-workflow',
				description: 'Workflow that only uses packageStorage',
			},
		},
		bundledEntry:
			'export default async () => { const storage = packageStorage(); return { version: "pre-binding-storage-bundle", value: await storage.get("skill") } }',
	})

	const { artifact } = await ensureModuleArtifact({
		env,
		baseUrl: 'https://kody.dev',
		savedPackage,
		selector: { kind: 'export', exportName: 'nightly' },
		userId,
	})

	const modules = Object.values(artifact.modules).join('\n')
	expect(modules).toContain('userEntrypoint')
	expect(modules).not.toContain('pre-binding-storage-bundle')
})

test('a pre-binding module bundle whose source needs an npm install keeps serving and logs the republish need', async () => {
	silenceIncidentalRuntimeWarnings([/pre_binding_bundle_needs_republish/])
	const { env, savedPackage } = await seedPreBindingModuleBundle({
		suffix: 'pre-binding-npm-workflow',
		manifest: {
			name: '@kody/pre-binding-npm-workflow',
			exports: { './nightly': './src/nightly.ts' },
			dependencies: { 'left-pad': '^1.3.0' },
			kody: {
				id: 'pre-binding-npm-workflow',
				description: 'Nightly workflow with an npm dependency',
			},
		},
	})

	const { artifact } = await ensureModuleArtifact({
		env,
		baseUrl: 'https://kody.dev',
		savedPackage,
		selector: { kind: 'export', exportName: 'nightly' },
		userId,
	})

	expect(Object.values(artifact.modules).join('\n')).toContain(
		'pre-binding-bundle',
	)
	expect(
		consoleWarn.mock.calls.some((call) =>
			String(call[0]).includes('pre_binding_bundle_needs_republish'),
		),
	).toBe(true)
})
