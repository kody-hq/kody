import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import {
	createLocalExecutePackageRuntimeModuleSource,
	createLocalExecuteRuntimeShimSource,
} from './local-execute-runtime-support.ts'
import {
	packageBoundRuntimeCreatorNames,
	packageBoundRuntimeExportNames,
	packageBoundRuntimeExports,
	sharedRuntimeExportReasons,
} from './package-bound-runtime-exports.ts'
import {
	buildPackageRuntimeModulePath,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
	kodyRuntimeSharedExportNames,
} from './runtime-source-modules.ts'

const storageSymbol = Symbol.for('kody.runtimeStorage')
const globalAny = globalThis as unknown as Record<symbol, unknown>
const storage = (globalAny[storageSymbol] ??=
	new AsyncLocalStorage()) as AsyncLocalStorage<Record<string, unknown>>
const roots: Array<string> = []

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true })))
})

test('every kody:runtime export is either package-bound or shared for a stated reason', () => {
	const bound = new Set<string>(packageBoundRuntimeExportNames)
	const shared = new Set(Object.keys(sharedRuntimeExportReasons))
	expect([...bound].filter((name) => shared.has(name))).toEqual([])
	const publicExports = [
		...kodyRuntimeSharedExportNames,
		'packageStorage',
		'packageSecrets',
	]
	expect(
		publicExports.filter((name) => !bound.has(name) && !shared.has(name)),
	).toEqual([])
	expect(
		[...bound, ...shared].filter((name) => !publicExports.includes(name)),
	).toEqual([])
})

test('hosted and local facades bind the same exports with the same creators', () => {
	for (const source of [
		createPackageRuntimeModuleSource('pkg-a'),
		createLocalExecutePackageRuntimeModuleSource('pkg-a'),
	]) {
		const reexported = /^export \{([^}]*)\} from/m
			.exec(source)![1]!
			.split(',')
			.map((name) => name.trim())
		expect(reexported.sort()).toEqual(
			Object.keys(sharedRuntimeExportReasons).sort(),
		)
		for (const entry of packageBoundRuntimeExports) {
			const line = new RegExp(`^export const ${entry.name} = (.+);$`, 'm').exec(
				source,
			)
			expect({ name: entry.name, found: line !== null }).toEqual({
				name: entry.name,
				found: true,
			})
			expect(line![1]).toMatch(
				entry.creator === '__kodyCreatePackageBoundCredentialRuntime'
					? new RegExp(`^__kodyPackageCredentialRuntime\\.${entry.name}$`)
					: new RegExp(`^${entry.creator}\\("pkg-a"\\)$`),
			)
		}
	}
})

test('the hosted runtime and the local shim export every facade creator', () => {
	const hosted = createRuntimeModuleSource()
	const local = createLocalExecuteRuntimeShimSource()
	for (const creator of packageBoundRuntimeCreatorNames()) {
		expect(hosted).toMatch(new RegExp(`export function ${creator}\\(`))
		expect(local).toMatch(new RegExp(`export function ${creator}\\(`))
	}
})

test('the local execute shim exports every shared facade re-export', () => {
	const local = createLocalExecuteRuntimeShimSource()
	for (const name of Object.keys(sharedRuntimeExportReasons)) {
		expect(local).toMatch(
			new RegExp(
				`(?:export function ${name}\\b|export \\{[\\s\\S]*\\b${name}\\b)`,
			),
		)
	}
})

async function loadHostedPackageRuntime(
	packageId: string,
	runtime: Record<string, unknown>,
) {
	// Resolve macOS temp-directory symlinks so relative and direct imports share one module.
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), 'kody-bound-exports-')),
	)
	roots.push(root)
	const runtimePath = path.join(root, '.__kody_virtual__', 'runtime.js')
	const packagePath = path.join(root, buildPackageRuntimeModulePath(packageId))
	await mkdir(path.dirname(packagePath), { recursive: true })
	await writeFile(runtimePath, createRuntimeModuleSource())
	await writeFile(packagePath, createPackageRuntimeModuleSource(packageId))
	return await storage.run(runtime, async () => ({
		shared: (await import(pathToFileURL(runtimePath).href)) as {
			__kodyRunWithPackageBindings: <T>(
				bindings: Map<string, unknown>,
				callback: () => Promise<T>,
			) => Promise<T>
		},
		module: (await import(pathToFileURL(packagePath).href)) as Record<
			string,
			unknown
		> & { default: Record<string, unknown> },
		run: <T>(callback: () => Promise<T>) => storage.run(runtime, callback),
	}))
}

test("an imported package's createAuthenticatedFetch and oauthClientCredentials act through its binding", async () => {
	const runLevel: Array<string> = []
	const { shared, module, run } = await loadHostedPackageRuntime('pkg-locked', {
		createAuthenticatedFetch: async () => {
			runLevel.push('createAuthenticatedFetch')
			return async () => new Response('run-level')
		},
		oauthClientCredentials: async () => {
			runLevel.push('oauthClientCredentials')
			return {}
		},
	})
	const calls: Array<{ name: string; args: unknown }> = []
	const fetched: Array<{ url: string; authorization: string | null }> = []
	const binding = {
		kodyCall: async (name: string, args: unknown) => {
			calls.push({ name, args })
			return {
				integration: {
					name: 'svc',
					apiBaseUrl: 'https://api.example.com',
					requiredHosts: ['api.example.com', 'auth.example.com'],
				},
			}
		},
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			fetched.push({
				url: request.url,
				authorization: request.headers.get('authorization'),
			})
			return Response.json({ access_token: 'placeholder-only' })
		},
	}
	const bindings = new Map([['pkg-locked', binding]])
	const createAuthenticatedFetch = module.createAuthenticatedFetch as (
		name: string,
	) => Promise<(input: string) => Promise<Response>>
	const oauthClientCredentials = module.oauthClientCredentials as (
		input: Record<string, unknown>,
	) => Promise<unknown>

	await run(() =>
		shared.__kodyRunWithPackageBindings(bindings, async () => {
			const authed = await createAuthenticatedFetch('svc')
			await authed('/v1/me')
			await oauthClientCredentials({
				tokenUrl: 'https://auth.example.com/token',
				clientIdSecret: 'clientId',
				clientSecretSecret: 'clientSecret',
			})
			expect(module.default.createAuthenticatedFetch).toBe(
				createAuthenticatedFetch,
			)
		}),
	)

	expect(runLevel).toEqual([])
	expect(calls).toEqual([{ name: 'integrationGet', args: { name: 'svc' } }])
	expect(fetched).toEqual([
		{
			url: 'https://api.example.com/v1/me',
			authorization: 'Bearer {{integration-token:svc}}',
		},
		{
			url: 'https://auth.example.com/token',
			authorization: '{{secret-basic:username=clientId,password=clientSecret}}',
		},
	])

	// No binding in scope: the run's own helper answers, as before.
	await run(async () => {
		await createAuthenticatedFetch('svc')
		await oauthClientCredentials({})
	})
	expect(runLevel).toEqual([
		'createAuthenticatedFetch',
		'oauthClientCredentials',
	])
})

test('a runtime without the integration helpers keeps them absent on the facade', async () => {
	const { module } = await loadHostedPackageRuntime('pkg-plain', {})
	expect(module.createAuthenticatedFetch).toBeUndefined()
	expect(module.oauthClientCredentials).toBeUndefined()
})
