const { TextEncoder } = globalThis
// Minimal WebAssembly binary encoder for the production probe. Runs in Node
// (tests) and inside the probe Worker, which only builds bytes and never
// compiles them.

const textEncoder = new TextEncoder()

function concat(parts) {
	let length = 0
	for (const part of parts) length += part.length
	const out = new Uint8Array(length)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

function u8(...values) {
	return Uint8Array.from(values)
}

export function uleb(value) {
	const out = []
	let n = value
	do {
		let byte = n % 128
		n = Math.floor(n / 128)
		if (n !== 0) byte |= 0x80
		out.push(byte)
	} while (n !== 0)
	return Uint8Array.from(out)
}

function vec(items) {
	return concat([uleb(items.length), ...items])
}

function name(value) {
	const bytes = textEncoder.encode(value)
	return concat([uleb(bytes.length), bytes])
}

function section(id, payload) {
	return concat([u8(id), uleb(payload.length), payload])
}

function body(locals, instructions) {
	const content = concat([locals, instructions])
	return concat([uleb(content.length), content])
}

const i32 = 0x7f
const padChunkBytes = 256 * 1024

function padFunctionInstructions() {
	// i32.const 0, then (i32.const 1, i32.add) repeated, then end.
	const repeats = Math.floor((padChunkBytes - 3) / 3)
	const out = new Uint8Array(2 + repeats * 3 + 1)
	out[0] = 0x41
	out[1] = 0x00
	for (let i = 0; i < repeats; i += 1) {
		out[2 + i * 3] = 0x41
		out[3 + i * 3] = 0x01
		out[4 + i * 3] = 0x6a
	}
	out[out.length - 1] = 0x0b
	return out
}

/**
 * Builds a valid module exporting `add(i32, i32) -> i32`, `busy(i32) -> i32`
 * (a CPU loop) and `memory`. `padKind` grows it to about `padBytes`:
 * `code` adds 256 KiB function bodies (compile cost), `data` adds an active
 * data segment copied into linear memory at instantiate (memory cost).
 */
export function buildModule({ padKind = 'none', padBytes = 0 } = {}) {
	const padFunctionCount =
		padKind === 'code' ? Math.max(1, Math.round(padBytes / padChunkBytes)) : 0
	const dataBytes = padKind === 'data' ? padBytes : 0
	const memoryPages = Math.max(1, Math.ceil(dataBytes / 65536))

	const types = section(
		1,
		vec([
			u8(0x60, 2, i32, i32, 1, i32),
			u8(0x60, 1, i32, 1, i32),
			u8(0x60, 0, 1, i32),
		]),
	)
	const functionIndexes = [u8(0), u8(1)]
	for (let i = 0; i < padFunctionCount; i += 1) functionIndexes.push(u8(2))
	const functions = section(3, vec(functionIndexes))
	const memory = section(5, vec([concat([u8(0x00), uleb(memoryPages)])]))
	const exportsSection = section(
		7,
		vec([
			concat([name('add'), u8(0x00, 0)]),
			concat([name('busy'), u8(0x00, 1)]),
			concat([name('memory'), u8(0x02, 0)]),
		]),
	)

	const addBody = body(u8(0), u8(0x20, 0, 0x20, 1, 0x6a, 0x0b))
	const busyBody = body(
		u8(1, 1, i32),
		u8(
			0x02,
			0x40,
			0x03,
			0x40,
			0x20,
			0,
			0x45,
			0x0d,
			1,
			0x20,
			0,
			0x41,
			1,
			0x6b,
			0x21,
			0,
			0x20,
			1,
			0x41,
			3,
			0x6c,
			0x41,
			7,
			0x6a,
			0x21,
			1,
			0x0c,
			0,
			0x0b,
			0x0b,
			0x20,
			1,
			0x0b,
		),
	)
	const bodies = [addBody, busyBody]
	if (padFunctionCount > 0) {
		const padBody = body(u8(0), padFunctionInstructions())
		for (let i = 0; i < padFunctionCount; i += 1) bodies.push(padBody)
	}
	const code = section(10, vec(bodies))

	const parts = [
		u8(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00),
		types,
		functions,
		memory,
		exportsSection,
		code,
	]
	if (dataBytes > 0) {
		const payload = new Uint8Array(dataBytes)
		let x = 0x9e3779b9
		for (let i = 0; i < dataBytes; i += 1) {
			x ^= x << 13
			x ^= x >>> 17
			x ^= x << 5
			payload[i] = x & 0xff
		}
		parts.push(
			section(
				11,
				vec([concat([u8(0x00, 0x41, 0x00, 0x0b), uleb(dataBytes), payload])]),
			),
		)
	}
	return concat(parts)
}
