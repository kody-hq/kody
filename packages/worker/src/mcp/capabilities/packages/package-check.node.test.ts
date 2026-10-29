import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createSnapshotFilesWorkspace } from '#worker/repo/checks.ts'
import { runAuthoringPublishChecks } from '#worker/repo/authoring-publish-checks.ts'

const mockModule = vi.hoisted(() => ({
	resolvePackageOwnerContext: vi.fn(),
	resolveOwnedPackageSource: vi.fn(),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('./resolve-package-source.ts', () => ({
	resolveOwnedPackageSource: (...args: Array<unknown>) =>
		mockModule.resolveOwnedPackageSource(...args),
}))

const { packageCheckCapability } = await import('./package-check.ts')

const owner = {
	ownerUserId: ownerIdFromStored('user-1'),
	ownerScope: 'acme',
	ownerEmail: 'user-1@example.com',
	actorUserId: 'user-1',
}
const env = { APP_DB: {} } as unknown as Env

function callerContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.test',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
	})
}

/**
 * The reported case: a stamped package (kody.credentials declared, so the
 * credential stamp gate applies) whose fetch uses a `|scope=package`
 * placeholder. Local bundling is happy with it; publish refuses it.
 */
function stampedScopePackageFiles(): Record<string, string> {
	return {
		'package.json': JSON.stringify({
			name: '@acme/poll',
			type: 'module',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'poll',
				description: 'Polls an API.',
				credentials: {
					TOKEN: { kind: 'secret', description: 'API token for the poll.' },
				},
			},
		}),
		'README.md': '# poll\n\nPolls an API.\n',
		'AGENTS.md': '# Agents\n\nCall the default export.\n',
		'src/index.ts': [
			'export default async function poll() {',
			"\tconst response = await fetch('https://api.example.com/poll', {",
			"\t\theaders: { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' },",
			'\t})',
			'\treturn response.status',
			'}',
		].join('\n'),
	}
}

async function check(
	files: Record<string, string>,
	binaryFiles?: Record<string, number>,
) {
	return (await packageCheckCapability.handler(
		{ files, ...(binaryFiles ? { binary_files: binaryFiles } : {}) },
		{ env, callerContext: callerContext() },
	)) as {
		ok: boolean
		package_name: string | null
		checks: Array<{ kind: string; ok: boolean; message: string }>
	}
}

function resetMocks() {
	mockModule.resolvePackageOwnerContext.mockReset()
	mockModule.resolveOwnedPackageSource.mockReset()
	mockModule.resolvePackageOwnerContext.mockResolvedValue(owner)
	mockModule.resolveOwnedPackageSource.mockRejectedValue(
		new Error('Package not found.'),
	)
}

test('packageCheck refuses a stamped package that uses |scope=package, with the publish gate message', async () => {
	resetMocks()
	const result = await check(stampedScopePackageFiles())
	expect(result.ok).toBe(false)
	expect(result.package_name).toBe('@acme/poll')
	const credentials = result.checks.find(
		(entry) => entry.kind === 'credentials',
	)
	expect(credentials?.ok).toBe(false)
	expect(credentials?.message).toMatch(/Credential stamp publish gate/)
	expect(credentials?.message).toMatch(/\|scope=/)
	// The gate stops the run, exactly as publish does.
	expect(result.checks.some((entry) => entry.kind === 'bundle')).toBe(false)
	expect(mockModule.resolveOwnedPackageSource).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: owner.ownerUserId,
			ownerScope: 'acme',
			args: { kody_id: 'poll' },
		}),
	)
})

test('packageCheck reports the same results publish computes for the same tree', async () => {
	resetMocks()
	const files = stampedScopePackageFiles()
	const viaCapability = await check(files)
	// Publish (publishFromExternalRef) calls runAuthoringPublishChecks on its
	// cloned workspace with the owner scope. Same tree, same answer.
	const viaPublish = await runAuthoringPublishChecks({
		workspace: createSnapshotFilesWorkspace(files),
		manifestPath: 'package.json',
		sourceRoot: '/',
		env,
		baseUrl: 'https://kody.test',
		userId: owner.ownerUserId,
		expectedPackageScope: 'acme',
	})
	expect(viaCapability.ok).toBe(viaPublish.ok)
	expect(viaCapability.checks).toEqual(
		viaPublish.results.map((entry) => ({
			kind: entry.kind,
			ok: entry.ok,
			message: entry.message,
		})),
	)
})

test('packageCheck refuses a package scope publish would refuse', async () => {
	resetMocks()
	const files = stampedScopePackageFiles()
	files['package.json'] = files['package.json']!.replace('@acme/', '@other/')
	const result = await check(files)
	expect(result.ok).toBe(false)
	expect(result.checks[0]).toMatchObject({ kind: 'manifest', ok: false })
})

test('packageCheck rejects paths outside the package root', async () => {
	resetMocks()
	await expect(
		check({ ...stampedScopePackageFiles(), '../secrets.txt': 'nope' }),
	).rejects.toThrow(/relative to the package root/)
})

/** A package app whose `kody.app.assets` directory holds only PNG files. */
function binaryOnlyAssetsPackageFiles(): Record<string, string> {
	return {
		'package.json': JSON.stringify({
			name: '@acme/maintenance',
			type: 'module',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'maintenance',
				description: 'Tracks home maintenance.',
				app: { entry: './src/app.ts', assets: './icons' },
			},
		}),
		'README.md': '# maintenance\n\nTracks home maintenance.\n',
		'AGENTS.md': '# Agents\n\nCall the default export.\n',
		'src/index.ts': 'export default async function run() {\n\treturn 1\n}\n',
		'src/app.ts': [
			'export default {',
			'\tasync fetch() {',
			'\t\treturn new Response(\'<link rel="icon" href="_assets/icon-192.png">\', {',
			"\t\t\theaders: { 'content-type': 'text/html' },",
			'\t\t})',
			'\t},',
			'}',
		].join('\n'),
	}
}

const binaryOnlyAssets = {
	'icons/icon-192.png': 52_126,
	'icons/icon-512.png': 343_198,
}

test('packageCheck counts binary_files toward a binary-only kody.app.assets directory', async () => {
	resetMocks()
	// The app bundle phase runs after the assets gate; worker-bundler warns.
	consoleWarn.mockImplementation(() => {})
	const emptyAssetsMessage =
		'package.json#kody.app.assets points at "icons", but no files exist under that directory. Add the static files or remove the field.'
	const withoutBinaries = await check(binaryOnlyAssetsPackageFiles())
	expect(withoutBinaries.checks).toContainEqual({
		kind: 'bundle',
		ok: false,
		message: emptyAssetsMessage,
	})

	const withBinaries = await check(
		binaryOnlyAssetsPackageFiles(),
		binaryOnlyAssets,
	)
	expect(withBinaries.checks.map((entry) => entry.message)).not.toContain(
		emptyAssetsMessage,
	)
	// Past the assets gate, the run reaches the app bundle phase (which can
	// only build inside workerd, so Node reports that instead).
	expect(withBinaries.checks).toContainEqual(
		expect.objectContaining({
			kind: 'bundle',
			message: expect.stringMatching(/^src\/app\.ts: /),
		}),
	)
})

test('packageCheck counts binary_files toward the publish size limit', async () => {
	resetMocks()
	const result = await check(binaryOnlyAssetsPackageFiles(), {
		'icons/huge.png': 64 * 1024 * 1024,
	})
	expect(result.ok).toBe(false)
	expect(result.checks.some((entry) => /MiB|bytes/.test(entry.message))).toBe(
		true,
	)
})

test('packageCheck rejects a path in both files and binary_files', async () => {
	resetMocks()
	await expect(
		check(binaryOnlyAssetsPackageFiles(), { 'src/app.ts': 10 }),
	).rejects.toThrow(/both files and binary_files/)
	await expect(
		check(binaryOnlyAssetsPackageFiles(), { '../icon.png': 10 }),
	).rejects.toThrow(/relative to the package root/)
})

function isolatedCheckEnv(
	runIsolatedAuthoringChecks: (request: Record<string, unknown>) => unknown,
) {
	const kv = {
		put: vi.fn(async (_key: string, _value: string, _options: unknown) => {}),
		delete: vi.fn(async (_key: string) => {}),
	}
	const namespace = {
		idFromName: vi.fn((name: string) => ({ name })),
		get: vi.fn(() => ({ runIsolatedAuthoringChecks })),
	}
	return {
		kv,
		namespace,
		env: {
			APP_DB: {},
			REPO_SESSION: namespace,
			BUNDLE_ARTIFACTS_KV: kv,
		} as unknown as Env,
	}
}

test('packageCheck runs the publish checks in a throwaway check isolate when the bindings exist', async () => {
	resetMocks()
	const files = stampedScopePackageFiles()
	const runIsolatedAuthoringChecks = vi.fn(async () => ({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Validated.' }],
	}))
	const isolated = isolatedCheckEnv(runIsolatedAuthoringChecks)
	const result = (await packageCheckCapability.handler(
		{ files },
		{ env: isolated.env, callerContext: callerContext() },
	)) as { ok: boolean; checks: Array<{ kind: string; ok: boolean }> }
	expect(result).toMatchObject({
		ok: true,
		checks: [{ kind: 'manifest', ok: true }],
	})
	const [stagingKey, staged] = isolated.kv.put.mock.calls[0]!
	expect(stagingKey).toMatch(/^repo-checks-staging:v1:user-1:/)
	expect(JSON.parse(staged)).toEqual({ sourceFiles: files })
	expect(isolated.namespace.idFromName).toHaveBeenCalledWith(
		expect.stringMatching(/^isolated-authoring-checks-user-1-/),
	)
	expect(runIsolatedAuthoringChecks).toHaveBeenCalledWith({
		stagingKey,
		userId: owner.ownerUserId,
		baseUrl: 'https://kody.test',
		expectedPackageScope: 'acme',
	})
	expect(isolated.kv.delete).toHaveBeenCalledWith(stagingKey)

	await packageCheckCapability.handler(
		{ files, binary_files: { './icons/icon-192.png': 52_126 } },
		{ env: isolated.env, callerContext: callerContext() },
	)
	expect(JSON.parse(isolated.kv.put.mock.calls[1]![1])).toEqual({
		sourceFiles: files,
		binaryFileSizes: { 'icons/icon-192.png': 52_126 },
	})
})

test('packageCheck names the memory or CPU limit when the check isolate is reset', async () => {
	resetMocks()
	const isolated = isolatedCheckEnv(async () => {
		throw new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		)
	})
	const result = (await packageCheckCapability.handler(
		{ files: stampedScopePackageFiles() },
		{ env: isolated.env, callerContext: callerContext() },
	)) as {
		ok: boolean
		checks: Array<{ kind: string; ok: boolean; message: string }>
	}
	expect(result.ok).toBe(false)
	expect(result.checks).toHaveLength(1)
	expect(result.checks[0]).toMatchObject({ kind: 'bundle', ok: false })
	expect(result.checks[0]!.message).toMatch(/ran out of memory or CPU time/)
	expect(isolated.kv.delete).toHaveBeenCalled()
})
