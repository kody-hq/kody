#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, arch, release, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { compactResults } from './summary.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
function required(flag) {
	const value = args[args.indexOf(flag) + 1]
	if (!args.includes(flag) || !value || value.startsWith('--'))
		throw new Error(`Missing ${flag}`)
	return path.resolve(value)
}
const before = required('--before')
const after = required('--after')
const out = required('--out')
if (args.includes('--reuse-builds'))
	throw new Error(
		'Build reuse is not supported. Run without --reuse-builds to build fresh production artifacts.',
	)
if (before === after)
	throw new Error('Before and after must be separate source snapshots.')
const beforeRef = args[args.indexOf('--before-ref') + 1]
if (!args.includes('--before-ref') || !beforeRef || beforeRef.startsWith('--'))
	throw new Error('Missing --before-ref')
await mkdir(out, { recursive: true })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
function command(root, executable, argv) {
	return execFileSync(executable, argv, {
		cwd: root,
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	})
}
const documentPaths = [
	'readme.md',
	'docs/guides/package-lifecycle.md',
	'docs/guides/package-authoring.md',
	'docs/guides/credentials.md',
]
const documents = await Promise.all(
	documentPaths.map(async (relative) => {
		const markdown = await readFile(path.join(before, relative), 'utf8')
		if (markdown !== (await readFile(path.join(after, relative), 'utf8')))
			throw new Error(`Corpus differs: ${relative}`)
		return {
			path: relative,
			markdown,
			sha256: sha256(markdown),
			bytes: Buffer.byteLength(markdown),
		}
	}),
)
const applicationPaths = [
	'packages/worker/start/components/markdown-view.tsx',
	'packages/worker/start/components/syntax-highlight.tsx',
	'packages/worker/src/app/highlight-code.ts',
	'packages/worker/client/markdown-first-party.ts',
	'packages/worker/universal/markdown.ts',
	'packages/worker/universal/markdown-first-party.ts',
	'packages/worker/universal/highlighted-code.ts',
	'packages/worker/public/styles.css',
	'packages/highlight-worker/src/tokenize.ts',
]
async function sourceHashes(root) {
	return Object.fromEntries(
		await Promise.all(
			applicationPaths.map(async (relative) => {
				try {
					return [relative, sha256(await readFile(path.join(root, relative)))]
				} catch (error) {
					if (error.code === 'ENOENT') return [relative, null]
					throw error
				}
			}),
		),
	)
}
const variants = []
for (const [name, root] of [
	['before', before],
	['after', after],
]) {
	console.log(`Building ${name} production artifacts`)
	const destination = path.join(out, name)
	await mkdir(destination, { recursive: true })
	// Only generated output is removed. Clean builds avoid counting stale hashes.
	await rm(path.join(root, 'dist'), { recursive: true, force: true })
	const script = `
 const { ensureWorkerBundlerModules } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools/build-worker-bundler-modules.ts')).href)});
 const { ensureGuideCatalogModules } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools/build-guide-catalog-modules.ts')).href)});
 await ensureWorkerBundlerModules(); await ensureGuideCatalogModules();
 const { buildOriginProductionViteBundle } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools/origin-vite-startup-build.ts')).href)});
 console.log(JSON.stringify(await buildOriginProductionViteBundle(${JSON.stringify(path.join(destination, 'origin'))})));`
	await writeFile(
		path.join(destination, 'origin-build.log'),
		command(root, process.execPath, ['--input-type=module', '-e', script]),
	)
	await writeFile(
		path.join(destination, 'highlight-build.log'),
		command(root, path.join(root, 'node_modules/.bin/wrangler'), [
			'deploy',
			'--dry-run',
			'--env',
			'production',
			'--config',
			'packages/highlight-worker/wrangler.jsonc',
			'--outdir',
			path.join(destination, 'highlight'),
		]),
	) // Compile identical harness source against each snapshot's actual modules.
	const entrySource = (
		await readFile(path.join(here, 'sample-entry.mjs'), 'utf8')
	).replaceAll('../../packages/', `${root}/packages/`)
	const entryPath = path.join(destination, 'sample.mjs')
	await build({
		stdin: { contents: entrySource, resolveDir: root, loader: 'ts' },
		outfile: entryPath,
		bundle: true,
		platform: 'node',
		format: 'esm',
		minify: true,
		define: { 'process.env.NODE_ENV': '"production"' },
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: {
			react: path.join(
				root,
				'node_modules/@tanstack/redact/dist/react/index.js',
			),
			'react/jsx-runtime': path.join(
				root,
				'node_modules/@tanstack/redact/dist/react/jsx-runtime.js',
			),
			'react/jsx-dev-runtime': path.join(
				root,
				'node_modules/@tanstack/redact/dist/react/jsx-runtime.js',
			),
			'react-dom/server': path.join(
				root,
				'node_modules/@tanstack/redact/dist/server/index.js',
			),
			'react-dom/client': path.join(
				root,
				'node_modules/@tanstack/redact/dist/dom/client.js',
			),
			'react-dom': path.join(
				root,
				'node_modules/@tanstack/redact/dist/dom/index.js',
			),
			scheduler: path.join(
				root,
				'node_modules/@tanstack/redact/dist/scheduler/index.js',
			),
			'#client': path.join(root, 'packages/worker/client'),
			'#universal': path.join(root, 'packages/worker/universal'),
			'#app': path.join(root, 'packages/worker/src/app'),
			'#worker': path.join(root, 'packages/worker/src'),
		},
		banner: {
			js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(root, 'package.json'))});`,
		},
	})
	// External ESM packages resolve beside the harness, using this snapshot's deps.
	const { symlink } = await import('node:fs/promises')
	await rm(path.join(destination, 'node_modules'), { force: true })
	await symlink(
		path.join(root, 'node_modules'),
		path.join(destination, 'node_modules'),
	)
	const lock = JSON.parse(
		await readFile(path.join(root, 'package-lock.json'), 'utf8'),
	)
	variants.push({
		name,
		root,
		destination,
		entryPath,
		lockSha256: sha256(await readFile(path.join(root, 'package-lock.json'))),
		versions: Object.fromEntries(
			[
				'marked',
				'shiki',
				'@tanstack/markdown',
				'@tanstack/highlight',
				'vite',
				'esbuild',
				'wrangler',
				'react',
				'seroval',
				'@hono/node-server',
			].map((name) => [
				name,
				lock.packages[`node_modules/${name}`]?.version ?? null,
			]),
		),
	})
}
// The baseline's real fence extraction defines one identical highlighting input.
const baselineEntry = await import(pathToFileURL(variants[0].entryPath).href)
const snippets = documents.flatMap((document) =>
	baselineEntry.parse(document.markdown),
)
const fixturesPath = path.join(out, 'fixtures.json')
await writeFile(fixturesPath, JSON.stringify({ documents, snippets }))
for (let round = 0; round < 5; round++) {
	for (const variant of round % 2 ? [...variants].reverse() : variants) {
		console.log(`Timing ${variant.name}, round ${round + 1}/5`)
		command(variant.root, process.execPath, [
			path.join(here, 'measure.mjs'),
			variant.entryPath,
			fixturesPath,
			path.join(variant.destination, `timing-${round}.json`),
		])
	}
}
async function filesUnder(dir) {
	const files = []
	for (const item of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, item.name)
		if (item.isDirectory()) files.push(...(await filesUnder(full)))
		else files.push(full)
	}
	return files
}
async function bundleFiles(dir) {
	const result = []
	for (const file of await filesUnder(dir)) {
		if (!/\.(?:js|mjs|css|wasm)$/.test(file)) continue
		const content = await readFile(file)
		const mapPath = `${file}.map`
		let sources = []
		try {
			sources = JSON.parse(await readFile(mapPath, 'utf8')).sources ?? []
		} catch {
			/* Some emitted assets have no source map. */
		}
		result.push({
			path: path.relative(dir, file),
			bytes: content.length,
			gzipBytes: gzipSync(content, { level: 9 }).length,
			sha256: sha256(content),
			markdown: sources.some((source) =>
				/(?:marked|@tanstack\/markdown|markdown-view|markdown-first-party|universal\/markdown\.ts)/.test(
					source,
				),
			),
			highlighter: sources.some((source) =>
				/(?:shiki|@tanstack\/highlight)/.test(source),
			),
		})
	}
	return result
}
const results = {
	measuredAt: new Date().toISOString(),
	renderer: '@tanstack/redact/server, production branches, minified harness',
	baselineCommit: command(after, 'git', ['rev-parse', beforeRef]).trim(),
	sourceDiffSha256: sha256(
		command(after, 'git', ['diff', '--binary', beforeRef]),
	),
	machine: {
		node: process.version,
		platform: platform(),
		arch: arch(),
		osRelease: release(),
		cpu: cpus()[0]?.model,
		logicalCpus: cpus().length,
		memoryBytes: totalmem(),
	},
	corpus: documents.map((document) => ({
		path: document.path,
		sha256: document.sha256,
		bytes: document.bytes,
	})),
	snippetCount: snippets.length,
	variants: [],
}
for (const variant of variants) {
	console.log(`Profiling ${variant.name} Worker startup`)
	const startup = { origin: [], highlight: [] }
	for (const target of ['origin', 'highlight']) {
		const config =
			target === 'origin'
				? path.join(variant.destination, 'origin/server/wrangler.json')
				: path.join(variant.root, 'packages/highlight-worker/wrangler.jsonc')
		for (let run = 0; run < 5; run++) {
			const log = command(
				path.dirname(config),
				path.join(variant.root, 'node_modules/.bin/wrangler'),
				[
					'check',
					'startup',
					'--config',
					config,
					...(target === 'highlight' ? ['--env', 'production'] : []),
					'--outfile',
					path.join(variant.destination, `${target}-${run}.cpuprofile`),
				],
			)
			await writeFile(
				path.join(variant.destination, `${target}-startup-${run}.log`),
				log,
			)
			const match = /Active:\s*([\d.]+)\s*ms/.exec(log)
			if (!match) throw new Error('Missing startup CPU summary')
			startup[target].push(Number(match[1]))
		}
	}
	const timings = await Promise.all(
		Array.from({ length: 5 }, async (_, index) =>
			JSON.parse(
				await readFile(
					path.join(variant.destination, `timing-${index}.json`),
					'utf8',
				),
			),
		),
	)
	results.variants.push({
		name: variant.name,
		lockSha256: variant.lockSha256,
		versions: variant.versions,
		sourceHashes: await sourceHashes(variant.root),
		startup,
		timings,
		bundles: {
			client: await bundleFiles(
				path.join(variant.destination, 'origin/client'),
			),
			server: await bundleFiles(
				path.join(variant.destination, 'origin/server'),
			),
			highlight: await bundleFiles(path.join(variant.destination, 'highlight')),
		},
	})
}
await writeFile(
	path.join(out, 'results.json'),
	`${JSON.stringify(results, null, 2)}\n`,
)
// Keep the compact raw result in source, large builds and profiles stay in --out.
if (args.includes('--save')) {
	const savePath = required('--save')
	await mkdir(path.dirname(savePath), { recursive: true })
	await writeFile(
		savePath,
		`${JSON.stringify(compactResults(results), null, 2)}\n`,
	)
}
console.log(`Results: ${path.join(out, 'results.json')}`)
