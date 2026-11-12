import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

await mkdir('.tmp/files-spike', { recursive: true })
await Promise.all([
	build({
		entryPoints: ['tools/files-spike/browser.ts'],
		outfile: '.tmp/files-spike/browser.js',
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		sourcemap: true,
	}),
	build({
		entryPoints: ['tools/files-spike/worker.ts'],
		outfile: '.tmp/files-spike-worker.mjs',
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		external: ['cloudflare:workers'],
		target: 'es2022',
		conditions: ['workerd', 'worker', 'browser'],
	}),
	...['index.html', 'style.css'].map((name) =>
		copyFile(`tools/files-spike/${name}`, `.tmp/files-spike/${name}`),
	),
])
