import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { buildHarfbuzzCallbackWasm } from './harfbuzz-callbacks.ts'

const require = createRequire(import.meta.url)

/** Every signature string hbjs passes to `addFunction(callback, '<sig>')`. */
function hbjsCallbackSignatures(): Array<string> {
	const source = readFileSync(require.resolve('harfbuzzjs/hbjs.js'), 'utf8')
	const signatures = new Set<string>()
	for (const match of source.matchAll(/addFunction\(/g)) {
		let depth = 0
		let end = match.index + 'addFunction'.length
		for (; end < source.length; end++) {
			if (source[end] === '(') depth++
			else if (source[end] === ')' && --depth === 0) break
		}
		const signature = /'([a-z]+)'\s*\)$/.exec(
			source.slice(match.index, end + 1),
		)
		if (!signature) throw new Error('hbjs addFunction call without a signature')
		signatures.add(signature[1]!)
	}
	return [...signatures].sort()
}

test('harfbuzz-callbacks.wasm covers every hbjs callback signature', () => {
	const committed = readFileSync(
		new URL('./harfbuzz-callbacks.wasm', import.meta.url),
	)
	const expected = buildHarfbuzzCallbackWasm(hbjsCallbackSignatures())
	// After a harfbuzzjs bump changes the list, regenerate the file with
	// `writeFileSync('harfbuzz-callbacks.wasm', expected)`.
	expect(Buffer.from(committed).equals(Buffer.from(expected))).toBe(true)
	const module = new WebAssembly.Module(committed)
	expect(WebAssembly.Module.exports(module).map((entry) => entry.name)).toEqual(
		hbjsCallbackSignatures(),
	)
})
