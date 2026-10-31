/**
 * Local deps under path-like workerd module names (`kody:@scope/pkg/export`)
 * must not path-join `kody:runtime` or nested `kody:@` imports. Repro cases
 * from platform feedback: (A) dep → kody:runtime, (B) dep → local dep,
 * (C) both.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startWorkerd } from '../src/dev/workerd-process.js'
import {
	absolutizeWorkerdPackageImports,
	listSavedPackageImports,
	needsWorkerdAbsoluteImportPrefix,
	rewriteBareKodyBuiltinImports,
} from '../src/local-package-graph.js'
import {
	createRuntimeFlatAliasSource,
	createWorkerdConfig,
	localWorkerModuleNames,
} from '../src/local-runtime-source.js'
import { resolveLocalPackageModules } from '../src/mock-local-deps.js'
import { loadPackageManifest } from '../src/package-manifest.js'
import { ensureWorkerdBinary } from '../src/workerd-binary.js'

test('needsWorkerdAbsoluteImportPrefix covers runtime alias and kody:@ only', () => {
	assert.equal(
		needsWorkerdAbsoluteImportPrefix(localWorkerModuleNames.runtimeFlatAlias),
		true,
	)
	assert.equal(needsWorkerdAbsoluteImportPrefix('kody:@a/b/c'), true)
	assert.equal(needsWorkerdAbsoluteImportPrefix('/kody:@a/b/c'), false)
	assert.equal(
		needsWorkerdAbsoluteImportPrefix(
			`/${localWorkerModuleNames.runtimeFlatAlias}`,
		),
		false,
	)
	assert.equal(needsWorkerdAbsoluteImportPrefix('kody:runtime'), false)
	assert.equal(needsWorkerdAbsoluteImportPrefix('./relative.js'), false)
})

test('absolutizeWorkerdPackageImports prefixes after rewrite; nested scan still sees kody:@', async () => {
	const rewritten = await rewriteBareKodyBuiltinImports(`
import { kody } from 'kody:runtime'
import leaf from 'kody:@repro/leaf/value'
`)
	assert.deepEqual(await listSavedPackageImports(rewritten), [
		'kody:@repro/leaf/value',
	])
	const absolute = await absolutizeWorkerdPackageImports(rewritten)
	assert.match(absolute, /from ['"]\/\.__kody_runtime__\.js['"]/)
	assert.match(absolute, /from ['"]\/kody:@repro\/leaf\/value['"]/)
	// Leading `/` hides them from the nested kody:@ scanner — callers must
	// scan before absolutizing.
	assert.deepEqual(await listSavedPackageImports(absolute), [])
})

async function writeReproTree(parent: string): Promise<{
	app: string
	leaf: string
	mid: string
	runtimeDep: string
}> {
	const app = join(parent, 'app')
	const leaf = join(parent, 'leaf')
	const mid = join(parent, 'mid')
	const runtimeDep = join(parent, 'runtime-dep')
	await mkdir(join(app, '.kody'), { recursive: true })
	await mkdir(leaf, { recursive: true })
	await mkdir(mid, { recursive: true })
	await mkdir(runtimeDep, { recursive: true })

	await writeFile(
		join(leaf, 'package.json'),
		JSON.stringify({
			name: '@repro/leaf',
			type: 'module',
			exports: { './value': './value.ts' },
			kody: { id: 'leaf' },
		}),
	)
	await writeFile(join(leaf, 'value.ts'), `export const value = 'leaf-ok'\n`)

	await writeFile(
		join(mid, 'package.json'),
		JSON.stringify({
			name: '@repro/mid',
			type: 'module',
			exports: { './main': './main.ts' },
			kody: { id: 'mid' },
		}),
	)
	await writeFile(
		join(mid, 'main.ts'),
		`import { value } from 'kody:@repro/leaf/value'\nexport const mid = value\n`,
	)

	await writeFile(
		join(runtimeDep, 'package.json'),
		JSON.stringify({
			name: '@repro/runtime-dep',
			type: 'module',
			exports: { './main': './main.ts' },
			kody: { id: 'runtime-dep' },
		}),
	)
	await writeFile(
		join(runtimeDep, 'main.ts'),
		`import { kody } from 'kody:runtime'\nexport const hasKody = typeof kody === 'object'\n`,
	)

	await writeFile(
		join(app, 'package.json'),
		JSON.stringify({
			name: '@repro/app',
			type: 'module',
			exports: { './main': './main.ts' },
			kody: { id: 'app' },
		}),
	)
	await writeFile(
		join(app, '.kody/deps.json'),
		JSON.stringify({
			'@repro/leaf': '../leaf',
			'@repro/mid': '../mid',
			'@repro/runtime-dep': '../runtime-dep',
		}),
	)
	return { app, leaf, mid, runtimeDep }
}

test('A: local dep importing kody:runtime absolutizes the flat runtime alias', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'kody-local-abs-a-'))
	try {
		const { app } = await writeReproTree(parent)
		await writeFile(
			join(app, 'main.ts'),
			`import { hasKody } from 'kody:@repro/runtime-dep/main'\nexport default async () => hasKody\n`,
		)
		const resolved = await resolveLocalPackageModules({
			code: `import { hasKody } from 'kody:@repro/runtime-dep/main'\nexport default async () => hasKody\n`,
			packageRoot: app,
			selfManifest: await loadPackageManifest(app),
		})
		assert.equal(resolved.unresolved.length, 0)
		const mod = resolved.modules.find(
			(m) => m.name === 'kody:@repro/runtime-dep/main',
		)
		assert.ok(mod)
		assert.match(mod.esModule, /from ["']\/\.__kody_runtime__\.js["']/)
		assert.doesNotMatch(mod.esModule, /from ["']\.__kody_runtime__\.js["']/)
		assert.doesNotMatch(mod.esModule, /kody:@repro\/runtime-dep\/\.__kody/)
	} finally {
		await rm(parent, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('B: local dep importing another local dep absolutizes the nested kody:@ import', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'kody-local-abs-b-'))
	try {
		const { app } = await writeReproTree(parent)
		const resolved = await resolveLocalPackageModules({
			code: `import { mid } from 'kody:@repro/mid/main'\nexport default async () => mid\n`,
			packageRoot: app,
			selfManifest: await loadPackageManifest(app),
		})
		assert.equal(resolved.unresolved.length, 0)
		const midMod = resolved.modules.find(
			(m) => m.name === 'kody:@repro/mid/main',
		)
		assert.ok(midMod)
		assert.match(midMod.esModule, /from ["']\/kody:@repro\/leaf\/value["']/)
		assert.doesNotMatch(
			midMod.esModule,
			/from ["']kody:@repro\/leaf\/value["']/,
		)
		assert.ok(resolved.modules.some((m) => m.name === 'kody:@repro/leaf/value'))
	} finally {
		await rm(parent, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('C: local dep importing both kody:runtime and a nested local dep', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'kody-local-abs-c-'))
	try {
		const { app, mid } = await writeReproTree(parent)
		await writeFile(
			join(mid, 'main.ts'),
			`import { kody } from 'kody:runtime'\nimport { value } from 'kody:@repro/leaf/value'\nexport const both = { hasKody: typeof kody === 'object', value }\n`,
		)
		const resolved = await resolveLocalPackageModules({
			code: `import { both } from 'kody:@repro/mid/main'\nexport default async () => both\n`,
			packageRoot: app,
			selfManifest: await loadPackageManifest(app),
		})
		assert.equal(resolved.unresolved.length, 0)
		const midMod = resolved.modules.find(
			(m) => m.name === 'kody:@repro/mid/main',
		)
		assert.ok(midMod)
		assert.match(midMod.esModule, /from ["']\/\.__kody_runtime__\.js["']/)
		assert.match(midMod.esModule, /from ["']\/kody:@repro\/leaf\/value["']/)
		assert.ok(resolved.modules.some((m) => m.name === 'kody:@repro/leaf/value'))
	} finally {
		await rm(parent, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('A/B/C: resolved local dep modules load in workerd without path-join errors', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'kody-local-abs-workerd-'))
	const workDir = await mkdtemp(join(tmpdir(), 'kody-local-abs-wd-'))
	let handle: Awaited<ReturnType<typeof startWorkerd>> | undefined
	try {
		const { app, mid } = await writeReproTree(parent)
		await writeFile(
			join(mid, 'main.ts'),
			`import { kody } from 'kody:runtime'\nimport { value } from 'kody:@repro/leaf/value'\nexport const both = { hasKody: typeof kody === 'object', value }\n`,
		)
		const entryCode = `import { both } from 'kody:@repro/mid/main'\nexport default async () => both\n`
		await writeFile(join(app, 'main.ts'), entryCode)
		const resolved = await resolveLocalPackageModules({
			code: entryCode,
			packageRoot: app,
			selfManifest: await loadPackageManifest(app),
		})
		assert.equal(resolved.unresolved.length, 0)

		const workerdPath = await ensureWorkerdBinary()
		await writeFile(
			join(workDir, 'entry.js'),
			`import user from "./main.js";
export default {
  async fetch() {
    const result = await user();
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  },
};
`,
		)
		await writeFile(
			join(workDir, 'main.js'),
			`import { both } from "kody:@repro/mid/main";\nexport default async () => both;\n`,
		)
		// Minimal kody:runtime stand-in — only typeof checks in the fixture.
		await writeFile(
			join(workDir, 'runtime.js'),
			`export const kody = { mock: true };\nexport default { kody };\n`,
		)
		await writeFile(
			join(workDir, localWorkerModuleNames.runtimeFlatAlias),
			createRuntimeFlatAliasSource(),
		)
		for (const [index, module] of resolved.modules.entries()) {
			const file = `pkg-${index}.js`
			await writeFile(join(workDir, file), module.esModule)
		}
		const config = createWorkerdConfig({
			bridgePort: 1,
			files: {
				entry: 'entry.js',
				user: 'main.js',
				runtime: 'runtime.js',
			},
			packageModules: resolved.modules.map((module, index) => ({
				name: module.name,
				file: `pkg-${index}.js`,
			})),
		})
		const configPath = join(workDir, 'config.capnp')
		await writeFile(configPath, config)
		handle = await startWorkerd({
			workerdPath,
			configPath,
			cwd: workDir,
			env: { ...process.env, KODY_RUN_SECRET: 'test-secret' },
			onStdoutLine: () => {},
			onStderrLine: () => {},
		})
		const response = await fetch(`http://127.0.0.1:${handle.port}/`, {
			headers: { 'x-kody-run-secret': 'test-secret' },
		})
		// Local execute entry checks the run secret; this minimal entry does not.
		// Just proving modules linked: a 200 with JSON body.
		const body = await response.text()
		assert.equal(response.status, 200, body)
		assert.deepEqual(JSON.parse(body), { hasKody: true, value: 'leaf-ok' })
	} finally {
		await handle?.kill()
		await rm(parent, { recursive: true, force: true, maxRetries: 10 })
		await rm(workDir, { recursive: true, force: true, maxRetries: 10 })
	}
})
