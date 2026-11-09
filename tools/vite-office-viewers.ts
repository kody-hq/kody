import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { type Plugin } from 'vite'
const id = 'virtual:kody-office-viewers'
export async function buildOfficeViewerAssets() {
	const assets = new Map<string, { name: string; script: Uint8Array }>()
	for (const kind of ['docx', 'xlsx', 'pptx']) {
		const result = await build({
			entryPoints: [
				path.resolve(
					`packages/worker/start/pages/file-viewers/hosts/${kind}.ts`,
				),
			],
			bundle: true,
			write: false,
			minify: true,
			format: 'iife',
			platform: 'browser',
			alias: { '#universal': path.resolve('packages/worker/universal') },
			target: 'es2022',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		const script = result.outputFiles[0]!.contents
		const hash = createHash('sha256').update(script).digest('hex').slice(0, 12)
		const name = `office-viewers/${kind}-${hash}.js`
		assets.set(kind, { name, script })
	}
	return assets
}
/** Independent classic scripts keep document parsing out of Kody's origin and
 * keep all renderer dependencies out of workspace route chunks. */
export function officeViewers(): Plugin {
	const assets = new Map<string, Uint8Array>()
	const manifest: Record<string, string> = {}
	let base = '/'
	return {
		name: 'kody-office-viewers',
		async configResolved(config) {
			base = config.base
			for (const [kind, asset] of await buildOfficeViewerAssets()) {
				assets.set(asset.name, asset.script)
				manifest[kind] = base + asset.name
			}
		},
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? '/', 'http://local').pathname
				if (!pathname.startsWith(base)) return next()
				const asset = assets.get(pathname.slice(base.length))
				if (!asset) return next()
				response.setHeader(
					'Content-Type',
					'application/javascript; charset=utf-8',
				)
				response.setHeader('X-Content-Type-Options', 'nosniff')
				response.setHeader(
					'Cache-Control',
					'public, max-age=31536000, immutable',
				)
				response.end(asset)
			})
			const hosts = path.resolve(
				'packages/worker/start/pages/file-viewers/hosts',
			)
			server.watcher.add(hosts)
			server.watcher.on('change', (file) => {
				if (file.startsWith(hosts + path.sep)) void server.restart()
			})
		},
		generateBundle() {
			if (this.environment.name === 'client') {
				this.emitFile({
					type: 'asset',
					fileName: '_headers',
					source: `${base}office-viewers/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n`,
				})
				for (const [fileName, source] of assets)
					this.emitFile({ type: 'asset', fileName, source })
			}
		},
		resolveId(source) {
			return source === id ? '\0' + id : null
		},
		load(source) {
			return source === '\0' + id
				? `export default ${JSON.stringify(manifest)}`
				: null
		},
	}
}
