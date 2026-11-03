import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { runAuthoringPublishChecks } from '#worker/repo/authoring-publish-checks.ts'
import {
	createSnapshotFilesWorkspace,
	deferredBundleCheckMessage,
} from '#worker/repo/checks.ts'
import { bytesToLatin1String } from '#universal/package-file-media.ts'

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

test('packageCheck and publish accept a data-only app package with no exports field', async () => {
	resetMocks()
	// The app bundle phase can only build inside workerd; Node warns and
	// reports a bundle failure past the manifest check.
	consoleWarn.mockImplementation(() => {})
	const files = {
		'package.json': JSON.stringify({
			name: '@acme/board',
			type: 'module',
			kody: {
				id: 'board',
				description: 'Data-only package with an app.',
				app: { entry: './src/app.ts' },
			},
		}),
		'README.md': '# board\n\nA board app.\n',
		'AGENTS.md': '# Agents\n\nOpen the app.\n',
		'src/app.ts':
			'export default { async fetch() { return new Response("ok") } }\n',
	}
	const viaCapability = await check(files)
	expect(viaCapability.package_name).toBe('@acme/board')
	expect(viaCapability.checks[0]).toEqual({
		kind: 'manifest',
		ok: true,
		message: 'Validated package.json.',
	})
	expect(
		viaCapability.checks.some((entry) => /exports/.test(entry.message)),
	).toBe(false)
	const viaPublish = await runAuthoringPublishChecks({
		workspace: createSnapshotFilesWorkspace(files),
		manifestPath: 'package.json',
		sourceRoot: '/',
		env,
		baseUrl: 'https://kody.test',
		userId: owner.ownerUserId,
		expectedPackageScope: 'acme',
	})
	expect(viaPublish.manifest?.exports).toEqual({})
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
	runIsolatedArtifactBuildCheck: (
		request: Record<string, unknown>,
	) => unknown = async () => {
		throw new Error('unexpected artifact build check')
	},
) {
	const kv = {
		get: vi.fn(async (_key: string, _type: string) => null),
		put: vi.fn(async (_key: string, _value: string, _options: unknown) => {}),
		delete: vi.fn(async (_key: string) => {}),
	}
	const namespace = {
		idFromName: vi.fn((name: string) => ({ name })),
		get: vi.fn(() => ({
			runIsolatedAuthoringChecks,
			runIsolatedArtifactBuildCheck,
		})),
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
		deferBundleCheckToRebuild: true,
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

function multiExportPackageFiles(): Record<string, string> {
	const names = ['a', 'b', 'c', 'd', 'e']
	return {
		'package.json': JSON.stringify({
			name: '@acme/many',
			type: 'module',
			exports: Object.fromEntries(
				names.map((name) => [`./${name}`, `./src/${name}.ts`]),
			),
			kody: { id: 'many', description: 'Many exports.' },
		}),
		...Object.fromEntries(
			names.map((name) => [
				`src/${name}.ts`,
				`export default () => '${name}'\n`,
			]),
		),
	}
}

const deferredBundle = {
	kind: 'bundle',
	ok: true,
	message: deferredBundleCheckMessage,
}

test('packageCheck builds the rebuild targets in the rebuild batches after deferring the bundle check', async () => {
	resetMocks()
	const runIsolatedArtifactBuildCheck = vi.fn(
		async (request: Record<string, unknown>) => {
			const targets = request.targets as Array<unknown>
			return {
				ok: true,
				message: 'built',
				results: targets.map((target) => ({ ok: true, message: '', target })),
			}
		},
	)
	const isolated = isolatedCheckEnv(
		async () => ({
			ok: true,
			results: [
				{ kind: 'manifest', ok: true, message: 'Validated.' },
				deferredBundle,
			],
		}),
		runIsolatedArtifactBuildCheck,
	)
	const result = (await packageCheckCapability.handler(
		{ files: multiExportPackageFiles() },
		{ env: isolated.env, callerContext: callerContext() },
	)) as {
		ok: boolean
		checks: Array<{ kind: string; ok: boolean; message: string }>
	}
	expect(result.ok).toBe(true)
	const chunks = runIsolatedArtifactBuildCheck.mock.calls.map(
		([request]) => (request.targets as Array<unknown>).length,
	)
	// Each export is a module and an importable-module target: 10 targets
	// in chunks of 4, exactly as the publish rebuild batches them.
	expect(chunks).toEqual([4, 4, 2])
	const [request] = runIsolatedArtifactBuildCheck.mock.calls[0]!
	expect(request.stagingKey).toMatch(
		/^repo-artifact-rebuild-staging:v1:user-1:/,
	)
	expect(result.checks[1]).toMatchObject({ kind: 'bundle', ok: true })
	expect(result.checks[1]!.message).toMatch(/Built all 10 runtime artifact/)
	expect(isolated.kv.delete).toHaveBeenCalledWith(request.stagingKey)
})

test('packageCheck fails when the rebuild bundling would fail and stops before later waves', async () => {
	resetMocks()
	const runIsolatedArtifactBuildCheck = vi.fn(
		async (request: Record<string, unknown>) => {
			const targets = request.targets as Array<{ entryPoint: string }>
			return {
				ok: false,
				message: 'boom',
				results: targets.map((target, index) => ({
					ok: index !== 0,
					message: index === 0 ? 'Could not resolve "missing"' : '',
					target,
				})),
			}
		},
	)
	const isolated = isolatedCheckEnv(
		async () => ({ ok: true, results: [deferredBundle] }),
		runIsolatedArtifactBuildCheck,
	)
	const result = (await packageCheckCapability.handler(
		{ files: multiExportPackageFiles() },
		{ env: isolated.env, callerContext: callerContext() },
	)) as {
		ok: boolean
		checks: Array<{ kind: string; ok: boolean; message: string }>
	}
	expect(result.ok).toBe(false)
	expect(result.checks[0]).toMatchObject({ kind: 'bundle', ok: false })
	expect(result.checks[0]!.message).toMatch(
		/artifact rebuild would fail.*Could not resolve "missing"/,
	)
	// First wave (two isolates) failed, so the third chunk never starts.
	expect(runIsolatedArtifactBuildCheck).toHaveBeenCalledTimes(2)
})

test('packageCheck checks binary_contents byte for byte as the publish snapshot', async () => {
	resetMocks()
	const isolated = isolatedCheckEnv(async () => ({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Validated.' }],
	}))
	const png = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
	])
	await packageCheckCapability.handler(
		{
			files: stampedScopePackageFiles(),
			binary_files: { 'icons/icon.png': png.byteLength },
			binary_contents: {
				'./icons/icon.png': Buffer.from(png).toString('base64'),
			},
		},
		{ env: isolated.env, callerContext: callerContext() },
	)
	const staged = JSON.parse(isolated.kv.put.mock.calls[0]![1])
	expect(staged.binaryFileSizes).toBeUndefined()
	expect(staged.sourceFiles['icons/icon.png']).toBe(bytesToLatin1String(png))
	await expect(
		packageCheckCapability.handler(
			{ files: stampedScopePackageFiles(), binary_contents: { 'x.png': '%%' } },
			{ env: isolated.env, callerContext: callerContext() },
		),
	).rejects.toThrow(/not valid base64/)
})

test('packageCheck applies .kodyignore before the git-push snapshot limit', async () => {
	resetMocks()
	const isolated = isolatedCheckEnv(async () => ({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Validated.' }],
	}))
	const files = {
		...stampedScopePackageFiles(),
		'.kodyignore': 'fixtures/\n',
		'fixtures/types.d.ts': 'export {}\n',
	}
	const huge = { 'fixtures/huge.bin': 40 * 1024 * 1024 }
	const ignored = (await packageCheckCapability.handler(
		{ files, binary_files: huge },
		{ env: isolated.env, callerContext: callerContext() },
	)) as { ok: boolean }
	expect(ignored.ok).toBe(true)
	const staged = JSON.parse(isolated.kv.put.mock.calls[0]![1])
	expect(Object.keys(staged.sourceFiles)).not.toContain('fixtures/types.d.ts')
	expect(staged.binaryFileSizes).toBeUndefined()
	expect(staged.kodyIgnoredDeclarationFiles).toEqual(['fixtures/types.d.ts'])

	const tooLarge = (await packageCheckCapability.handler(
		{
			files: stampedScopePackageFiles(),
			binary_files: { 'assets/huge.bin': 40 * 1024 * 1024 },
		},
		{ env: isolated.env, callerContext: callerContext() },
	)) as { ok: boolean; checks: Array<{ kind: string; message: string }> }
	expect(tooLarge.ok).toBe(false)
	expect(tooLarge.checks[0]!.message).toMatch(
		/over the 32 MiB publish snapshot limit/,
	)
})
