import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import {
	buildPackageRuntimeModulePath,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
} from './runtime-source-modules.ts'

const storageSymbol = Symbol.for('kody.runtimeStorage')
const globalAny = globalThis as unknown as Record<symbol, unknown>
const storage = (globalAny[storageSymbol] ??=
	new AsyncLocalStorage()) as AsyncLocalStorage<Record<string, unknown>>
const roots: Array<string> = []

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true })))
})

async function loadPackageRuntime(
	packageId: string,
	runtime: Record<string, unknown>,
) {
	const root = await mkdtemp(path.join(tmpdir(), 'kody-bound-credential-'))
	roots.push(root)
	const runtimePath = path.join(root, '.__kody_virtual__', 'runtime.js')
	const packagePath = path.join(root, buildPackageRuntimeModulePath(packageId))
	await mkdir(path.dirname(packagePath), { recursive: true })
	await writeFile(runtimePath, createRuntimeModuleSource())
	await writeFile(packagePath, createPackageRuntimeModuleSource(packageId))
	return await storage.run(runtime, async () => ({
		module: (await import(pathToFileURL(packagePath).href)) as Record<
			string,
			unknown
		> & { default: Record<string, unknown> },
		run: <T>(callback: () => Promise<T>) => storage.run(runtime, callback),
	}))
}

test("an imported package's credential() opens with that package's id, not the entry's", async () => {
	const opened: Array<unknown> = []
	const runtimeFor = (packageId: string) => ({
		credential: Object.assign(
			async (key: string) => {
				opened.push({ packageId, key })
				return { key }
			},
			{
				named: async (name: string) => {
					opened.push({ packageId, name })
					return { name }
				},
				visitor: async (need: string) => {
					opened.push({ packageId, need })
					return { need }
				},
			},
		),
		credentials: async (key: string) => {
			opened.push({ packageId, key, many: true })
			return []
		},
	})
	const { module, run } = await loadPackageRuntime('pkg-imported', {
		credential: async () => {
			throw new Error('the entry runtime must not be used')
		},
		credentials: async () => [],
		__kodyCredentialRuntimeFor: runtimeFor,
	})
	const credential = module.credential as ((
		key: string,
	) => Promise<unknown>) & {
		named: (name: string) => Promise<unknown>
		visitor: (need: string) => Promise<unknown>
	}
	await run(async () => {
		await credential('resend')
		await credential.named('resend-prod')
		await credential.visitor('github')
		await (module.credentials as (key: string) => Promise<unknown>)('resend')
		await (module.default.credential as (key: string) => Promise<unknown>)(
			'github',
		)
	})
	expect(opened).toEqual([
		{ packageId: 'pkg-imported', key: 'resend' },
		{ packageId: 'pkg-imported', name: 'resend-prod' },
		{ packageId: 'pkg-imported', need: 'github' },
		{ packageId: 'pkg-imported', key: 'resend', many: true },
		{ packageId: 'pkg-imported', key: 'github' },
	])

	const { module: plain } = await loadPackageRuntime('pkg-plain', {})
	expect(plain.credential).toBeUndefined()
	expect(plain.credentials).toBeUndefined()
	expect(plain.default.credential).toBeUndefined()
})
