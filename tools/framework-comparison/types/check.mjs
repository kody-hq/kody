#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
const [baselineArg, beforeArg, currentTemplate = 'start-contracts.ts.fixture'] =
	process.argv.slice(2)
const root = process.cwd()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kody-type-contracts-'))
fs.symlinkSync(
	path.join(root, 'node_modules'),
	path.join(work, 'node_modules'),
	'dir',
)
const fixture = path.join(root, 'tools/framework-comparison/types')
const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
const results = []
const beforeDeclarations = path.join(work, 'before-declarations')
const serverConfig = path.join(work, 'before-server.json')
fs.writeFileSync(
	serverConfig,
	JSON.stringify({
		extends: path.join(
			path.resolve(beforeArg),
			'packages/worker/tsconfig-start-server.json',
		),
		compilerOptions: {
			outDir: beforeDeclarations,
			types: [path.join(root, 'node_modules/@pitlane/dev/dist/assets.d.mts')],
			typeRoots: [path.join(root, 'node_modules/@types')],
		},
	}),
)
const generated = spawnSync(process.execPath, [tsc, '-p', serverConfig], {
	encoding: 'utf8',
})
if (generated.status !== 0) {
	console.log(
		JSON.stringify({
			phase: 'frozen-server-declarations',
			diagnostics: generated.stdout + generated.stderr,
		}),
	)
	process.exit(1)
}

// Generated declarations retain package imports such as #universal/*.ts.
// Preserve that package boundary in the temporary declaration tree.
fs.copyFileSync(
	path.join(path.resolve(beforeArg), 'packages/worker/package.json'),
	path.join(beforeDeclarations, 'packages/worker/package.json'),
)

for (const [label, sourceRoot, template] of [
	['remix', path.resolve(baselineArg), 'remix-contracts.ts.fixture'],
	['startBefore', path.resolve(beforeArg), 'start-contracts.ts.fixture'],
	['startCurrent', root, currentTemplate],
]) {
	const file = path.join(work, `${label}.ts`)
	const text = fs
		.readFileSync(path.join(fixture, template), 'utf8')
		.replaceAll('BASELINE_ROOT', sourceRoot)
		.replaceAll('../../../packages/', `${sourceRoot}/packages/`)
	fs.writeFileSync(file, text)
	const config = path.join(work, `${label}.json`)
	let paths =
		label === 'startBefore'
			? Object.fromEntries(
					Object.entries(
						JSON.parse(
							fs.readFileSync(
								path.join(sourceRoot, 'packages/worker/tsconfig-start.json'),
							),
						).compilerOptions.paths,
					).map(([key, values]) => [
						key,
						values.map((value) =>
							path.join(
								beforeDeclarations,
								value.replace('./.generated/start-types/', ''),
							),
						),
					]),
				)
			: undefined

	if (paths)
		paths = {
			...paths,
			'#universal/*': [path.join(sourceRoot, 'packages/worker/universal/*')],
			'#client/*': [path.join(sourceRoot, 'packages/worker/client/*')],
		}
	fs.writeFileSync(
		config,
		JSON.stringify({
			extends: path.join(
				label === 'remix' ? root : sourceRoot,
				'packages/worker/tsconfig-start.json',
			),
			compilerOptions: {
				...(paths ? { paths } : {}),
				types: [path.join(root, 'node_modules/vite/client.d.ts')],
				typeRoots: [path.join(root, 'node_modules/@types')],
			},
			include: [
				file,
				path.join(sourceRoot, 'packages/worker/client/types/**/*.d.ts'),
			],
			exclude: [],
		}),
	)
	const result = spawnSync(process.execPath, [tsc, '-p', config], {
		encoding: 'utf8',
	})
	results.push({
		label,
		passed: result.status === 0,
		diagnostics: result.stdout + result.stderr,
	})
}
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => !result.passed)) process.exitCode = 1
