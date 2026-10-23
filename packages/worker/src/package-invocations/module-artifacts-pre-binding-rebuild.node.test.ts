import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
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
import { ensureModuleArtifact } from './module-artifacts.ts'

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
}) {
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	const env = createJobServiceTestEnv({
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
	})
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
	const kvKey = await persistPublishedBundleArtifact({
		env: { APP_DB: db, BUNDLE_ARTIFACTS_KV: bundleKv } as Env,
		userId,
		source,
		kind: 'module',
		artifactName: './nightly',
		entryPoint: 'src/nightly.ts',
		mainModule: 'dist/bundled-entry.js',
		modules: {
			'dist/bundled-entry.js':
				'export default async () => { await fetch("https://example.com/"); return { version: "pre-binding-bundle" } }',
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
	return { env, savedPackage }
}

test('a pre-binding module bundle that inlines another package rebuilds before a workflow export step runs it', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env, savedPackage } = await seedPreBindingModuleBundle({
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
