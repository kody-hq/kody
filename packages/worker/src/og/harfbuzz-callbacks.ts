const wasmTypeCodes: Record<string, number> = {
	i: 0x7f,
	p: 0x7f,
	j: 0x7e,
	f: 0x7d,
	d: 0x7c,
	e: 0x6f,
}

function uleb128(value: number): Array<number> {
	const bytes: Array<number> = []
	do {
		let byte = value & 0x7f
		value >>>= 7
		if (value !== 0) byte |= 0x80
		bytes.push(byte)
	} while (value !== 0)
	return bytes
}

function vector(items: Array<Array<number>>): Array<number> {
	return [...uleb128(items.length), ...items.flat()]
}

function name(text: string): Array<number> {
	const bytes = [...new TextEncoder().encode(text)]
	return [...uleb128(bytes.length), ...bytes]
}

function section(id: number, body: Array<number>): Array<number> {
	return [id, ...uleb128(body.length), ...body]
}

function typeCodes(signature: string): Array<number> {
	return Array.from(signature, (type) => {
		const code = wasmTypeCodes[type]
		if (code === undefined) {
			throw new Error(`Unknown Emscripten signature type "${type}"`)
		}
		return code
	})
}

/**
 * Builds the bytes of `harfbuzz-callbacks.wasm`: for each Emscripten
 * signature, import `e.<signature>` and re-export it, which is the same
 * trampoline Emscripten's `convertJsFunctionToWasm` compiles at runtime.
 */
export function buildHarfbuzzCallbackWasm(
	signatures: Array<string>,
): Uint8Array {
	const types = signatures.map((signature) => {
		const params = typeCodes(signature.slice(1))
		const results = signature[0] === 'v' ? [] : typeCodes(signature[0]!)
		return [
			0x60,
			...uleb128(params.length),
			...params,
			...uleb128(results.length),
			...results,
		]
	})
	const imports = signatures.map((signature, index) => [
		...name('e'),
		...name(signature),
		0x00,
		...uleb128(index),
	])
	const exports = signatures.map((signature, index) => [
		...name(signature),
		0x00,
		...uleb128(index),
	])
	return Uint8Array.from([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...section(1, vector(types)),
		...section(2, vector(imports)),
		...section(7, vector(exports)),
	])
}
