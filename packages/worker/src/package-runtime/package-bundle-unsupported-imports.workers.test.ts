import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	buildKodyAppBundle,
	buildKodyAppClientBundle,
} from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

// `(module (func (export "add") (param i32 i32) (result i32) ...))`, kept
// byte-for-byte the way publish snapshots binary files.
const addWasm = String.fromCharCode(
	0,
	97,
	115,
	109,
	1,
	0,
	0,
	0,
	1,
	7,
	1,
	96,
	2,
	127,
	127,
	1,
	127,
	3,
	2,
	1,
	0,
	7,
	7,
	1,
	3,
	97,
	100,
	100,
	0,
	0,
	10,
	9,
	1,
	7,
	0,
	32,
	0,
	32,
	1,
	106,
	11,
)

function appSourceFiles(app: string, extra: Record<string, string> = {}) {
	return {
		'package.json': JSON.stringify({
			name: '@kody/wasm-app',
			kody: { id: 'wasm-app', app: { entry: './src/app.ts' } },
		}),
		'src/app.ts': app,
		'src/add.wasm': addWasm,
		...extra,
	}
}

async function appBundleError(sourceFiles: Record<string, string>) {
	silenceIncidentalRuntimeWarnings()
	return await buildKodyAppBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'user-wasm-imports',
		sourceFiles,
		entryPoint: 'src/app.ts',
	}).then(
		() => null,
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	)
}

test(
	'app entry .wasm imports fail with the import and a workaround, not esbuild bytes',
	{ timeout: 60_000 },
	async () => {
		const message = await appBundleError(
			appSourceFiles(
				"import add from './add.wasm'\nexport default { fetch: () => new Response(String(add)) }\n",
			),
		)
		expect(message).toContain('Cannot import "./add.wasm"')
		expect(message).toContain('.wasm imports are not supported')
		expect(message).toContain('kody.app.assets')
		expect(message).toContain('src/app.ts')
		expect(message).not.toContain('Unexpected')
	},
)

test(
	'other binary imports name the file instead of a JavaScript parse error',
	{ timeout: 60_000 },
	async () => {
		const message = await appBundleError(
			appSourceFiles(
				"import blob from './blob.bin'\nexport default { fetch: () => new Response(String(blob)) }\n",
				{ 'src/blob.bin': addWasm },
			),
		)
		expect(message).toContain(
			'Cannot bundle "src/blob.bin": it is a binary file',
		)
		expect(message).not.toContain('Unexpected')
	},
)

test(
	'browser client .wasm imports point at kody.app.assets',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const message = await buildKodyAppClientBundle({
			sourceFiles: appSourceFiles('export {}\n', {
				'src/client.ts': "import add from './add.wasm'\nconsole.log(add)\n",
			}),
			entryPoint: 'src/client.ts',
		}).then(
			() => null,
			(error: unknown) =>
				error instanceof Error ? error.message : String(error),
		)
		expect(message).toContain('Cannot import "./add.wasm"')
		expect(message).toContain('browser client')
		expect(message).toContain('WebAssembly.instantiateStreaming')
	},
)

test(
	'JavaScript with a literal NUL in a string still bundles',
	{ timeout: 60_000 },
	async () => {
		const message = await appBundleError(
			appSourceFiles(
				"import { sep } from './sep.ts'\nexport default { fetch: () => new Response(sep) }\n",
				{ 'src/sep.ts': 'export const sep = "a\0b"\n' },
			),
		)
		expect(message).toBeNull()
	},
)
