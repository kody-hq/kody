import createHarfBuzz from 'harfbuzzjs/hb.js'
import hbjs from 'harfbuzzjs/hbjs.js'
import hbWasm from 'harfbuzzjs/hb.wasm'
import callbackWasm from './harfbuzz-callbacks.wasm'

/**
 * Workers build stand-in for the `harfbuzzjs` entry that satori imports.
 * workerd forbids compiling WASM at runtime, and the package entry does it
 * twice: it fetches and compiles `hb.wasm`, and `addFunction` compiles a
 * trampoline per JS callback. Here both are static `.wasm` imports, compiled
 * at upload like yoga and resvg. Wired up by `tools/vite-harfbuzz-worker.ts`
 * in the Vite and Workers test configs; Node keeps the real entry.
 */
const callbackSignatures = new Set(
	WebAssembly.Module.exports(callbackWasm).map((entry) => entry.name),
)

function noop() {}

function toWasmFunction(func: Function, signature: string): Function {
	if (!callbackSignatures.has(signature)) {
		throw new Error(`harfbuzz-callbacks.wasm has no "${signature}" trampoline`)
	}
	const imports: Record<string, Function> = {}
	for (const name of callbackSignatures) {
		imports[name] = name === signature ? func : noop
	}
	const instance = new WebAssembly.Instance(callbackWasm, { e: imports })
	return instance.exports[signature] as Function
}

export default createHarfBuzz({
	instantiateWasm(imports, receive) {
		const instance = new WebAssembly.Instance(hbWasm, imports)
		receive(instance, hbWasm)
		return instance.exports
	},
}).then((module) => {
	const addFunction = module.addFunction
	module.addFunction = (func, signature) =>
		addFunction(toWasmFunction(func, signature), signature)
	return hbjs(module)
})
