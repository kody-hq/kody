import path from 'node:path'
import { type Plugin } from 'vite'

const workerEntry = path.resolve(
	import.meta.dirname,
	'../packages/worker/src/og/harfbuzz-worker.ts',
)

// Emscripten's environment probe in `harfbuzzjs/hb.js`. Under nodejs_compat
// workerd looks like a Worker (`self.location` is undefined) and like Node
// (`__dirname` is undefined), so both reads throw before `instantiateWasm`
// runs. Neither value is used: the stand-in hands over a precompiled module.
const hbJsGuards: Array<[string, string]> = [
	['_scriptName=self.location.href', '_scriptName=self.location?.href'],
	[
		'scriptDirectory=__dirname+"/"',
		'scriptDirectory=typeof __dirname!="undefined"?__dirname+"/":""',
	],
]

export function guardHarfbuzzEnvironmentProbe(source: string): string {
	let guarded = source
	for (const [from, to] of hbJsGuards) {
		if (guarded.split(from).length !== 2) {
			throw new Error(
				`harfbuzzjs/hb.js no longer contains \`${from}\` exactly once; update tools/vite-harfbuzz-worker.ts`,
			)
		}
		guarded = guarded.replace(from, to)
	}
	return guarded
}

/**
 * Workers builds of satori's text shaper: resolves `harfbuzzjs` to the
 * static-WASM stand-in and makes `hb.js` load inside workerd.
 */
export function harfbuzzWorker(): Plugin {
	return {
		name: 'harfbuzz-worker',
		enforce: 'pre',
		resolveId(source) {
			return source === 'harfbuzzjs' ? workerEntry : null
		},
		transform(code, id) {
			const filePath = id.split('?')[0] ?? id
			if (!filePath.endsWith('/harfbuzzjs/hb.js')) return null
			return { code: guardHarfbuzzEnvironmentProbe(code), map: null }
		},
	}
}
