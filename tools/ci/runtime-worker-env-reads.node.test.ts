import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { parse } from 'jsonc-parser'
import { expect, test } from 'vitest'

// The generated `Env` merges all three wrangler configs, so a runtime-reachable
// read of a binding that only `kody` / `kody-platform` declare still
// type-checks. This test bundles the runtime Worker entry, collects `env.NAME`
// reads, and fails when a name is neither declared in the runtime config nor
// in the reviewed baseline (secrets, dev flags, and guarded optional reads).
const runtimeEntry = 'packages/worker/src/runtime-worker.ts'
const runtimeConfigPath = 'packages/runtime-worker/wrangler.jsonc'
const baselinePath = 'tools/ci/runtime-worker-env-reads-baseline.json'

function collectDeclaredNames(
	config: unknown,
	names = new Set<string>(),
	inArray = false,
) {
	if (Array.isArray(config)) {
		for (const entry of config) collectDeclaredNames(entry, names, true)
		return names
	}
	if (!config || typeof config !== 'object') return names
	const { binding, name } = config as { binding?: unknown; name?: unknown }
	if (typeof binding === 'string') names.add(binding)
	else if (inArray && typeof name === 'string') names.add(name)
	for (const [key, value] of Object.entries(config)) {
		if (key === 'vars' && value && typeof value === 'object') {
			for (const varName of Object.keys(value)) names.add(varName)
		} else {
			collectDeclaredNames(value, names)
		}
	}
	return names
}

async function collectRuntimeEnvReads() {
	const result = await build({
		entryPoints: [runtimeEntry],
		bundle: true,
		write: false,
		metafile: true,
		platform: 'neutral',
		format: 'esm',
		external: ['cloudflare:*', 'node:*'],
		conditions: ['workerd', 'worker', 'import'],
		mainFields: ['module', 'main'],
		logLevel: 'silent',
		loader: {
			'.css': 'text',
			'.html': 'text',
			'.md': 'text',
			'.txt': 'text',
			'.wasm': 'binary',
		},
	})
	const reads = new Map<string, Set<string>>()
	for (const file of Object.keys(result.metafile.inputs)) {
		if (file.includes('node_modules')) continue
		const source = await readFile(file, 'utf8')
		for (const match of source.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)\b/g)) {
			const name = match[1]!
			const files = reads.get(name) ?? new Set<string>()
			files.add(file)
			reads.set(name, files)
		}
	}
	return reads
}

test('runtime Worker code reads only bindings its wrangler config declares', async () => {
	const [reads, config, baseline] = await Promise.all([
		collectRuntimeEnvReads(),
		readFile(runtimeConfigPath, 'utf8').then((source) => parse(source)),
		readFile(baselinePath, 'utf8').then(
			(source) => JSON.parse(source) as { undeclared: Array<string> },
		),
	])
	const declared = collectDeclaredNames(config)
	const allowed = new Set(baseline.undeclared)
	const unexpected = [...reads]
		.filter(([name]) => !declared.has(name) && !allowed.has(name))
		.map(([name, files]) => `${name} (${[...files].join(', ')})`)
	expect(
		unexpected,
		`Code reachable from ${runtimeEntry} reads env names that ${runtimeConfigPath} does not declare. Add the binding to every env in ${runtimeConfigPath}, or, for a secret or a guarded optional read, add the name to ${baselinePath}.`,
	).toEqual([])
	const stale = baseline.undeclared.filter(
		(name) => declared.has(name) || !reads.has(name),
	)
	expect(
		stale,
		`Remove these names from ${baselinePath}: they are declared in ${runtimeConfigPath} or no longer read.`,
	).toEqual([])
	expect(baseline.undeclared).toEqual([...baseline.undeclared].sort())
}, 60_000)
