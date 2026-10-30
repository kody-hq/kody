import { createHash } from 'node:crypto'

function bytes(files) {
	return {
		files: files.length,
		bytes: files.reduce((sum, file) => sum + file.bytes, 0),
		gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
	}
}
function summarize(files) {
	const javascript = files.filter((file) => /\.(?:js|mjs)$/.test(file.path))
	return {
		...bytes(files),
		javascript: bytes(javascript),
		css: bytes(files.filter((file) => file.path.endsWith('.css'))),
		wasm: bytes(files.filter((file) => file.path.endsWith('.wasm'))),
		manifestSha256: createHash('sha256')
			.update(JSON.stringify(files))
			.digest('hex'),
		entry: files.find((file) => file.path === 'index.js') ?? null,
		markdownChunks: files.filter((file) => file.markdown),
		highlighterChunks: files.filter((file) => file.highlighter),
		largestJavascript: [...javascript]
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, 10),
	}
}

/** Keep all timing samples, summarize unrelated chunks instead of committing builds. */
export function compactResults(results) {
	return {
		...results,
		variants: results.variants.map((variant) => ({
			...variant,
			bundles: Object.fromEntries(
				Object.entries(variant.bundles).map(([name, files]) => [
					name,
					summarize(files),
				]),
			),
		})),
	}
}
