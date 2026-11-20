import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const workerDir = fileURLToPath(new URL('../../worker', import.meta.url))

// Publish offload builder: the worker's own artifact builders, served from
// a local workerd (the bundler only runs there), so a CLI or
// execution-context build makes the same bytes as a cloud rebuild. The
// worker loads its bundler and source parser from generated additional
// modules; here each resolves straight to its source. .wasm imports stay
// external and are copied beside the bundle as workerd wasm modules.
const workerGeneratedModules = {
	'worker-bundler': '@cloudflare/worker-bundler',
	'worker-bundler-typescript': '@cloudflare/worker-bundler/typescript',
	'module-source-parser': './src/module-source-parser-module.ts',
}
// Generated modules the builder's import graph reaches but a build never
// loads (git, mail, OAuth, codemode). They stay external, and nothing serves
// them in the local workerd.
const workerGeneratedModulesBuildsNeverLoad = new Set([
	'codemode-normalize',
	'disposable-email-domains',
	'isomorphic-git',
	'oauth-provider',
	'postal-mime',
])

// The bundler's typecheck downloads TypeScript's lib .d.ts files from the npm
// registry on every run. Inside the CLI's workerd that made every local and
// context build fail with workerd's opaque `internal error; reference = …`
// on any machine that cannot reach registry.npmjs.org. The builder embeds
// the exact lib files the bundler pins instead, read from the
// `publish-builder-typescript-libs` dev dependency.
const typescriptLibsPackage = 'publish-builder-typescript-libs'
const typescriptLibMapPattern =
	/async function createDefaultTypeScriptLibMap\(\) \{\n[\s\S]*?version: "([^"]+)",[\s\S]*?\n\treturn result;\n\}/

function embeddedTypescriptLibMapSource(bundlerSource) {
	const match = typescriptLibMapPattern.exec(bundlerSource)
	if (!match) {
		throw new Error(
			'@cloudflare/worker-bundler no longer defines createDefaultTypeScriptLibMap the way packages/cli/scripts/build-publish-builder.mjs expects. Update the publish builder so it still embeds the TypeScript lib files instead of downloading them.',
		)
	}
	const require = createRequire(path.join(workerDir, 'index.js'))
	const libsPackageJson = require.resolve(
		`${typescriptLibsPackage}/package.json`,
	)
	const { version } = JSON.parse(readFileSync(libsPackageJson, 'utf8'))
	if (version !== match[1]) {
		throw new Error(
			`@cloudflare/worker-bundler typechecks with TypeScript ${match[1]} lib files, but ${typescriptLibsPackage} is ${version}. Set packages/cli devDependency ${typescriptLibsPackage} to npm:typescript@${match[1]}.`,
		)
	}
	const libDir = path.join(path.dirname(libsPackageJson), 'lib')
	const files = Object.fromEntries(
		readdirSync(libDir)
			.filter((name) => name.startsWith('lib.') && name.endsWith('.d.ts'))
			.sort()
			.map((name) => [name, readFileSync(path.join(libDir, name), 'utf8')]),
	)
	return bundlerSource.replace(
		typescriptLibMapPattern,
		() =>
			`async function createDefaultTypeScriptLibMap() {\n\treturn new Map(Object.entries(${JSON.stringify(files)}));\n}`,
	)
}

/**
 * Writes `publish-builder.js` and `publish-builder-wasm/` into `outDir`.
 */
export async function buildPublishBuilder({ outDir }) {
	const builderWasmDir = path.join(outDir, 'publish-builder-wasm')
	mkdirSync(builderWasmDir, { recursive: true })
	await build({
		entryPoints: {
			'publish-builder': path.join(
				workerDir,
				'src/publish-offload/builder-workerd-entry.ts',
			),
		},
		outdir: outDir,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		conditions: ['workerd', 'worker', 'browser'],
		target: 'es2024',
		external: ['node:*', 'cloudflare:*'],
		plugins: [
			{
				name: 'wasm-modules',
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /\.wasm$/ }, (args) => {
						const file = args.path.startsWith('.')
							? path.resolve(args.resolveDir, args.path)
							: createRequire(path.join(args.resolveDir, 'index.js')).resolve(
									args.path,
								)
						const name = path.basename(file)
						copyFileSync(file, path.join(builderWasmDir, name))
						return { path: `./${name}`, external: true }
					})
				},
			},
			{
				name: 'embedded-typescript-libs',
				setup(pluginBuild) {
					pluginBuild.onLoad(
						{
							filter:
								/@cloudflare[\\/]worker-bundler[\\/]dist[\\/]typescript\.js$/,
						},
						(args) => ({
							contents: embeddedTypescriptLibMapSource(
								readFileSync(args.path, 'utf8'),
							),
							loader: 'js',
						}),
					)
				},
			},
			{
				name: 'worker-generated-modules',
				setup(pluginBuild) {
					pluginBuild.onResolve(
						{ filter: /^\.\/generated\/.+\.mjs$/ },
						(args) => ({
							path: args.path,
							external: true,
						}),
					)
					pluginBuild.onResolve(
						{ filter: /\.kody-generated\/[^/]+\.mjs$/ },
						async (args) => {
							const name = args.path
								.replace(/^.*\.kody-generated\//, '')
								.replace(/\.mjs$/, '')
							if (workerGeneratedModulesBuildsNeverLoad.has(name)) {
								return { path: args.path, external: true }
							}
							const target = workerGeneratedModules[name]
							// An unlisted module would stay an import nothing can
							// resolve at run time. The source parser was one, and
							// builds then kept raw `kody:runtime` imports.
							if (!target) {
								return {
									errors: [
										{
											text: `The publish builder imports the worker generated module "${name}", which packages/cli/scripts/build-publish-builder.mjs does not bundle. Add it to workerGeneratedModules, or to workerGeneratedModulesBuildsNeverLoad if no build can load it.`,
										},
									],
								}
							}
							return await pluginBuild.resolve(target, {
								kind: args.kind,
								resolveDir: workerDir,
							})
						},
					)
				},
			},
		],
		logLevel: 'warning',
	})
}
