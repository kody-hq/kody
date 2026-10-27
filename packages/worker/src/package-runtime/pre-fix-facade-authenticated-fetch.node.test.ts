import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { afterAll, expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createKodyRuntimeExternalsPlugin } from './module-graph-bundle-builders.ts'
import {
	normalizeWorkspaceModulePath,
	resolveRelativeModulePath,
} from './module-graph-paths.ts'
import { publishedArtifactNeedsPackageBindingRebuild } from './pre-binding-artifact-repair.ts'
import {
	bundleArtifactVersion,
	readPublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import { createRuntimeModuleSource } from './runtime-source-modules.ts'

/**
 * End to end through the real load path (`readPublishedBundleArtifact`) for
 * bundles built before GHSA-5fv3 (fe2aca6a9). Each fixture bundles the
 * package facade source those builders emitted with esbuild and the shared
 * runtime externals plugin, stores it, reads it back, and runs it against
 * the current shared runtime with a per-package binding in scope. Package
 * code must reach `createAuthenticatedFetch` / `oauthClientCredentials`
 * through its own package binding, never the run's helper (which acts as
 * the caller and is refused as "execute" by a package-locked integration).
 */

/** `createPackageRuntimeModuleSource` as of fe2aca6a9^1 (Sep 23 to Oct 22). */
function preFixFacadeSource(packageId: string) {
	const id = JSON.stringify(packageId)
	return `
export { kody, createAuthenticatedFetch, secretHeaders, oauthClientCredentials, packageContext, email, workflows, packages, events } from "../runtime.js";
import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundStorage, __kodyCreatePackageBoundSecrets, __kodyCreatePackageBoundCredentialRuntime } from "../runtime.js";
export const packageStorage = __kodyCreatePackageBoundStorage(${id});
export const packageSecrets = __kodyCreatePackageBoundSecrets(${id});
const __kodyPackageCredentialRuntime = __kodyCreatePackageBoundCredentialRuntime(${id});
export const credential = __kodyPackageCredentialRuntime.credential;
export const credentials = __kodyPackageCredentialRuntime.credentials;
// The default export mirrors the shared runtime default but resolves
// packageStorage / packageSecrets / credential / credentials to this
// package's bound variants.
const __kodyPackageBound = Object.fromEntries(
	Object.entries({ packageStorage, packageSecrets, credential, credentials }).filter(
		([, value]) => value !== undefined,
	),
);
const __kodyPackageRuntimeDefault = new Proxy(__kodyBaseRuntimeDefault, {
	get(target, property, receiver) {
		if (Object.hasOwn(__kodyPackageBound, property)) return __kodyPackageBound[property];
		return Reflect.get(target, property, receiver);
	},
	has(target, property) {
		return Object.hasOwn(__kodyPackageBound, property) || Reflect.has(target, property);
	},
});
export default __kodyPackageRuntimeDefault;
// Per-package request-context key: \`context.get(KodyRuntime)\` resolves
// packageStorage / packageSecrets to the declaring package, matching the
// named exports above.
export const KodyRuntime = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });
`.trim()
}

/** `createPackageRuntimeModuleSource` before f4688dc5a (`export *` era). */
function starFacadeSource(packageId: string) {
	const id = JSON.stringify(packageId)
	return `
export * from "../runtime.js";
import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundStorage, __kodyCreatePackageBoundSecrets } from "../runtime.js";
export const packageStorage = __kodyCreatePackageBoundStorage(${id});
export const packageSecrets = __kodyCreatePackageBoundSecrets(${id});
// The default export mirrors the shared runtime default but resolves
// packageStorage / packageSecrets to this package's bound variants.
const __kodyPackageRuntimeDefault = new Proxy(__kodyBaseRuntimeDefault, {
	get(target, property, receiver) {
		if (property === 'packageStorage') return packageStorage;
		if (property === 'packageSecrets') return packageSecrets;
		return Reflect.get(target, property, receiver);
	},
	has(target, property) {
		return (
			property === 'packageStorage' ||
			property === 'packageSecrets' ||
			Reflect.has(target, property)
		);
	},
});
export default __kodyPackageRuntimeDefault;
// Per-package request-context key: \`context.get(KodyRuntime)\` resolves
// packageStorage / packageSecrets to the declaring package, matching the
// named exports above.
export const KodyRuntime = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });
`.trim()
}

const ownId = '162e0000-0000-4000-8000-000000000001'
const innerId = '162e0000-0000-4000-8000-000000000002'
const ownFacade = '.__kody_virtual__/package-runtime/0a.js'
const innerFacade = '.__kody_virtual__/package-runtime/0b.js'

const ownEntry = `import { createAuthenticatedFetch, oauthClientCredentials, packageStorage } from './${ownFacade}'
import runtime from './${ownFacade}'
export default async function plan() {
	void packageStorage
	const authed = await createAuthenticatedFetch('asana')
	await authed('/v1/me')
	await oauthClientCredentials({ tokenUrl: 'https://auth.example.com/token', clientIdSecret: 'clientId', clientSecretSecret: 'clientSecret' })
	await (await runtime.createAuthenticatedFetch('asana'))('/v1/default')
	return 'own'
}
`

const innerModule = `import { createAuthenticatedFetch } from './${innerFacade}'
export async function innerPlan() {
	const authed = await createAuthenticatedFetch('asana')
	await authed('/v1/inner')
}
`

const mixedEntry = `import { createAuthenticatedFetch } from './${ownFacade}'
import { innerPlan } from './inner.ts'
export default async function plan() {
	await innerPlan()
	const authed = await createAuthenticatedFetch('asana')
	await authed('/v1/me')
	return 'mixed'
}
`

function virtualFilesPlugin(files: Record<string, string>): Plugin {
	return {
		name: 'virtual-files',
		setup(pluginBuild) {
			pluginBuild.onResolve({ filter: /.*/ }, (args) => {
				const resolved =
					args.kind === 'entry-point'
						? normalizeWorkspaceModulePath(args.path)
						: (resolveRelativeModulePath(args.importer, args.path) ??
							normalizeWorkspaceModulePath(args.path))
				return { path: resolved, namespace: 'virtual' }
			})
			pluginBuild.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
				const contents = files[args.path]
				if (contents === undefined) {
					throw new Error(`Missing virtual fixture module ${args.path}`)
				}
				return {
					contents,
					loader: args.path.endsWith('.ts') ? 'ts' : 'js',
					resolveDir: dirname(args.path),
				}
			})
		},
	}
}

/** The bundle a pre-fix publish stored (shared runtime external). */
async function bundlePreFix(files: Record<string, string>) {
	const result = await build({
		entryPoints: ['index.ts'],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		write: false,
		absWorkingDir: '/',
		outfile: 'bundle.js',
		plugins: [
			createKodyRuntimeExternalsPlugin() as unknown as Plugin,
			virtualFilesPlugin(files),
		],
	})
	const output = result.outputFiles[0]?.text
	if (!output) throw new Error('Fixture bundle produced no output.')
	return output
}

/** Store the bundle and read it back through the load path. */
async function readBack(input: {
	bundle: string
	dependencies: Array<{ packageId: string }>
}) {
	const stored = {
		version: bundleArtifactVersion,
		kind: 'importable-module',
		sourceId: 'source-own',
		publishedCommit: 'c0ffee',
		entryPoint: 'index.ts',
		mainModule: 'bundle.js',
		dependencies: input.dependencies.map((dependency) => ({
			sourceId: `source-${dependency.packageId}`,
			publishedCommit: 'c0ffee',
			kodyId: dependency.packageId,
			packageId: dependency.packageId,
		})),
		packageContext: { packageId: ownId, kodyId: 'own', sourceId: 'source-own' },
		modules: { 'bundle.js': input.bundle },
		createdAt: '2026-10-20T00:00:00.000Z',
	}
	const env = {
		BUNDLE_ARTIFACTS_KV: { get: async () => stored },
	} as unknown as Env
	const artifact = await readPublishedBundleArtifact({ env, kvKey: 'k' })
	if (!artifact) throw new Error('stored artifact was not usable')
	return artifact
}

const storageSymbol = Symbol.for('kody.runtimeStorage')
const globalAny = globalThis as unknown as Record<symbol, unknown>
const runtimeStorage = (globalAny[storageSymbol] ??=
	new AsyncLocalStorage()) as AsyncLocalStorage<Record<string, unknown>>
const roots: Array<string> = []

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true })))
})

const executeRefusal =
	'Integration "asana" is limited to specific packages and cannot be used from execute'

/**
 * Run the served bundle's default export with a binding for every package
 * in it. The run's own helpers throw the refusal a package-locked
 * integration gives an execute caller.
 */
async function runServed(bundle: string, packageIds: Array<string>) {
	// Resolve macOS temp-directory symlinks so relative and direct imports share one module.
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), 'kody-pre-fix-facade-')),
	)
	roots.push(root)
	await mkdir(path.join(root, '.__kody_virtual__'), { recursive: true })
	await writeFile(
		path.join(root, '.__kody_virtual__', 'runtime.js'),
		createRuntimeModuleSource(),
	)
	await writeFile(path.join(root, 'bundle.js'), bundle)
	const runLevel: Array<string> = []
	const runtime = {
		createAuthenticatedFetch: async () => {
			runLevel.push('createAuthenticatedFetch')
			throw new Error(executeRefusal)
		},
		oauthClientCredentials: async () => {
			runLevel.push('oauthClientCredentials')
			throw new Error(executeRefusal)
		},
	}
	const viaBinding: Array<{ packageId: string; url: string }> = []
	const bindings = new Map(
		packageIds.map((packageId) => [
			packageId,
			{
				kodyCall: async () => ({
					integration: {
						name: 'asana',
						apiBaseUrl: 'https://app.asana.com/api/1.0',
						requiredHosts: ['app.asana.com', 'auth.example.com'],
					},
				}),
				fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
					viaBinding.push({ packageId, url: new Request(input, init).url })
					return Response.json({ ok: true })
				},
			},
		]),
	)
	return await runtimeStorage.run(runtime, async () => {
		const shared = (await import(
			pathToFileURL(path.join(root, '.__kody_virtual__', 'runtime.js')).href
		)) as {
			__kodyRunWithPackageBindings: <T>(
				bindings: Map<string, unknown>,
				callback: () => Promise<T>,
			) => Promise<T>
		}
		const served = (await import(
			pathToFileURL(path.join(root, 'bundle.js')).href
		)) as { default: () => Promise<string> }
		const result = await shared.__kodyRunWithPackageBindings(bindings, () =>
			served.default(),
		)
		return { result, runLevel, viaBinding }
	})
}

test('a pre-fix single-package bundle binds its integration helpers', async () => {
	const bundle = await bundlePreFix({
		'index.ts': ownEntry,
		[ownFacade]: preFixFacadeSource(ownId),
	})
	// The stored shape: no lexical fetch or kody in the facade.
	expect(bundle).not.toContain('__kodyCreatePackageBoundKody')
	expect(bundle).toMatch(/^import \{ kody, createAuthenticatedFetch,/m)
	const artifact = await readBack({ bundle, dependencies: [] })
	const served = artifact.modules['bundle.js'] as string
	const outcome = await runServed(served, [ownId])
	expect(outcome.runLevel).toEqual([])
	expect(outcome.result).toBe('own')
	expect(outcome.viaBinding).toEqual([
		{ packageId: ownId, url: 'https://app.asana.com/api/1.0/v1/me' },
		{ packageId: ownId, url: 'https://auth.example.com/token' },
		{ packageId: ownId, url: 'https://app.asana.com/api/1.0/v1/default' },
	])
})

test('a pre-fix mixed bundle binds each inlined package to itself', async () => {
	const bundle = await bundlePreFix({
		'index.ts': mixedEntry,
		'inner.ts': innerModule,
		[ownFacade]: preFixFacadeSource(ownId),
		[innerFacade]: preFixFacadeSource(innerId),
	})
	const artifact = await readBack({
		bundle,
		dependencies: [{ packageId: innerId }],
	})
	const outcome = await runServed(artifact.modules['bundle.js'] as string, [
		ownId,
		innerId,
	])
	expect(outcome.runLevel).toEqual([])
	expect(outcome.viaBinding).toEqual([
		{ packageId: innerId, url: 'https://app.asana.com/api/1.0/v1/inner' },
		{ packageId: ownId, url: 'https://app.asana.com/api/1.0/v1/me' },
	])
})

test('a pre-fix mixed bundle that needs npm install is served bound', async () => {
	const bundle = await bundlePreFix({
		'index.ts': mixedEntry,
		'inner.ts': innerModule,
		[ownFacade]: preFixFacadeSource(ownId),
		[innerFacade]: preFixFacadeSource(innerId),
	})
	const artifact = await readBack({
		bundle,
		dependencies: [{ packageId: innerId }],
	})
	// Rebuilding would need an npm install, so load sites serve this bundle.
	consoleWarn.mockImplementation(() => {})
	expect(
		publishedArtifactNeedsPackageBindingRebuild({
			artifact,
			sourceFiles: {
				'package.json': JSON.stringify({ dependencies: { 'date-fns': '4' } }),
			},
		}),
	).toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('pre_binding_bundle_needs_republish'),
	)
	const outcome = await runServed(artifact.modules['bundle.js'] as string, [
		ownId,
		innerId,
	])
	expect(outcome.runLevel).toEqual([])
	expect(outcome.viaBinding.map((call) => call.packageId)).toEqual([
		innerId,
		ownId,
	])
})

test('an `export *` era bundle binds its integration helpers', async () => {
	const bundle = await bundlePreFix({
		'index.ts': mixedEntry,
		'inner.ts': innerModule,
		[ownFacade]: starFacadeSource(ownId),
		[innerFacade]: starFacadeSource(innerId),
	})
	const artifact = await readBack({
		bundle,
		dependencies: [{ packageId: innerId }],
	})
	const outcome = await runServed(artifact.modules['bundle.js'] as string, [
		ownId,
		innerId,
	])
	expect(outcome.runLevel).toEqual([])
	expect(outcome.viaBinding.map((call) => call.packageId)).toEqual([
		innerId,
		ownId,
	])
})
