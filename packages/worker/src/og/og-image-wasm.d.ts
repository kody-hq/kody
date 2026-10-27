declare module 'satori/yoga.wasm' {
	const yogaWasm: WebAssembly.Module
	export default yogaWasm
}

declare module '@resvg/resvg-wasm/index_bg.wasm' {
	const resvgWasm: WebAssembly.Module
	export default resvgWasm
}

declare module 'harfbuzzjs/hb.wasm' {
	const harfbuzzWasm: WebAssembly.Module
	export default harfbuzzWasm
}

declare module '*/harfbuzz-callbacks.wasm' {
	const callbackWasm: WebAssembly.Module
	export default callbackWasm
}

declare module 'harfbuzzjs/hb.js' {
	type HarfBuzzModule = {
		addFunction: (func: Function, signature: string) => number
	}
	const createHarfBuzz: (module: {
		instantiateWasm: (
			imports: WebAssembly.Imports,
			receive: (
				instance: WebAssembly.Instance,
				module: WebAssembly.Module,
			) => void,
		) => WebAssembly.Exports
	}) => Promise<HarfBuzzModule>
	export default createHarfBuzz
}

declare module 'harfbuzzjs/hbjs.js' {
	const hbjs: (module: unknown) => unknown
	export default hbjs
}
