import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { buildOfficeViewerAssets } from './vite-office-viewers.ts'
for (const [kind, asset] of await buildOfficeViewerAssets())
	console.log(
		`${kind}: ${asset.script.byteLength} bytes minified, ${gzipSync(asset.script).byteLength} bytes gzip; loaded only for ${kind}`,
	)
const zip = await build({
	stdin: {
		contents: "import JSZip from 'jszip';globalThis.JSZip=JSZip",
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	minify: true,
	platform: 'browser',
})
console.log(
	`ZIP engine already used by Office: ${gzipSync(zip.outputFiles[0]!.contents).byteLength} bytes gzip; no additional transitive ZIP dependency needed`,
)
