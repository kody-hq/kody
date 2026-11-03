/**
 * Local copy of the platform's `<appBasePath>/_assets/` surface for `kody dev`:
 * the browser bundle of `kody.app.client` (fingerprinted `client.<hash>.js`),
 * `__version.json`, and files from the `kody.app.assets` directory. Answered
 * by the Node proxy before the app's fetch handler, like the platform does.
 * Everything is `no-store` so a rebuild is always picked up.
 */

import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { createBundleError } from '../local-bundle.js'
import { bundleInputs } from './dev-bundler.js'

const devAssetsPathPrefix = '/_assets/'
const devVersionAssetName = '__version.json'
const clientModuleHashLength = 16

export type DevClientBundle = {
	/** `client.<16-char base64url sha256>.js`, same shape as published apps. */
	name: string
	code: string
	inputs: Array<string>
}

export type DevClientBundler = {
	build: () => Promise<DevClientBundle>
	dispose: () => Promise<void>
}

export function createDevClientBundler(input: {
	entryPath: string
	root: string
	externals?: ReadonlyArray<string>
}): DevClientBundler {
	const externals = input.externals ?? []
	const workingDir = process.cwd()
	let disposed = false
	let context: Promise<
		esbuild.BuildContext<{ write: false; metafile: true }>
	> | null = null
	const createContext = () =>
		esbuild.context({
			absWorkingDir: workingDir,
			entryPoints: [resolve(input.entryPath)],
			bundle: true,
			write: false,
			metafile: true,
			format: 'esm',
			platform: 'browser',
			target: 'es2022',
			sourcemap: 'inline',
			logLevel: 'silent',
			outfile: join(input.root, '_assets', 'client.js'),
			plugins: externals.length > 0 ? [clientExternalsPlugin(externals)] : [],
		})
	return {
		build: async () => {
			try {
				// A context created after dispose would never be released and keeps Node alive.
				if (disposed) throw new Error('kody dev bundler was already disposed.')
				context ??= createContext()
				const result = await (await context).rebuild()
				const code =
					result.outputFiles.find((file) => file.path.endsWith('.js'))?.text ??
					''
				const hash = createHash('sha256')
					.update(code)
					.digest('base64url')
					.slice(0, clientModuleHashLength)
				return {
					name: `client.${hash}.js`,
					code,
					inputs: bundleInputs(result.metafile, workingDir),
				}
			} catch (error) {
				throw createBundleError(input.entryPath, error, {
					workingDir,
					displayRoot: input.root,
				})
			}
		},
		dispose: async () => {
			disposed = true
			const current = context
			context = null
			await (await current?.catch(() => null))?.dispose()
		},
	}
}

/**
 * Exact specifier or a subpath of it, so `preact` does not also externalize
 * `preact-render-to-string` (esbuild's own `external` matches by prefix).
 */
function clientExternalsPlugin(
	externals: ReadonlyArray<string>,
): esbuild.Plugin {
	return {
		name: 'kody-dev-client-externals',
		setup(build) {
			build.onResolve({ filter: /^[^./]/ }, (args) =>
				externals.some(
					(external) =>
						args.path === external || args.path.startsWith(`${external}/`),
				)
					? { path: args.path, external: true }
					: undefined,
			)
		},
	}
}

/** `/_assets/<rest>` → `<rest>` (percent-decoded), or null when not an asset path. */
export function parseDevAssetPath(pathname: string): string | null {
	if (!pathname.startsWith(devAssetsPathPrefix)) return null
	const encoded = pathname.slice(devAssetsPathPrefix.length)
	if (!encoded) return null
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

/** Absolute file under `assetsDir`, or null for traversal / absolute paths. */
export function resolveDevAssetFile(
	assetsDir: string,
	relativePath: string,
): string | null {
	if (relativePath.includes('\0') || relativePath.startsWith('/')) return null
	const root = resolve(assetsDir)
	const file = resolve(root, relativePath)
	return file.startsWith(`${root}${sep}`) ? file : null
}

export async function serveDevAsset(input: {
	req: IncomingMessage
	res: ServerResponse
	relativePath: string
	assetsDir: string | null
	client: DevClientBundle | null
	clientModuleUrl: string | null
	/** Origin-relative app mount ('' at the root). */
	appBasePath: string
}): Promise<void> {
	const { req, res } = input
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
		res.end('Method not allowed\n')
		return
	}
	if (input.relativePath === devVersionAssetName) {
		send(
			req,
			res,
			'application/json; charset=utf-8',
			JSON.stringify({
				clientModuleUrl: input.clientModuleUrl,
				assetBasePath: `${input.appBasePath}/_assets`,
				publishedCommit: null,
			}),
		)
		return
	}
	if (input.client && input.relativePath === input.client.name) {
		send(req, res, 'text/javascript; charset=utf-8', input.client.code)
		return
	}
	const file = input.assetsDir
		? resolveDevAssetFile(input.assetsDir, input.relativePath)
		: null
	const body = file ? await readAssetFile(file) : null
	if (!file || !body) {
		res.writeHead(404, {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
		})
		res.end('Not found\n')
		return
	}
	const contentType = inferDevAssetContentType(file)
	send(
		req,
		res,
		contentType,
		body,
		contentType.startsWith('text/javascript')
			? { 'service-worker-allowed': `${input.appBasePath}/` }
			: {},
	)
}

async function readAssetFile(file: string): Promise<Buffer | null> {
	try {
		if (!(await stat(file)).isFile()) return null
		return await readFile(file)
	} catch {
		return null
	}
}

function send(
	req: IncomingMessage,
	res: ServerResponse,
	contentType: string,
	body: string | Buffer,
	extraHeaders: Record<string, string> = {},
): void {
	const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
	res.writeHead(200, {
		'content-type': contentType,
		'content-length': String(bytes.length),
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...extraHeaders,
	})
	res.end(req.method === 'HEAD' ? undefined : bytes)
}

const contentTypesByExtension: Record<string, string> = {
	avif: 'image/avif',
	css: 'text/css; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	gif: 'image/gif',
	htm: 'text/html; charset=utf-8',
	html: 'text/html; charset=utf-8',
	ico: 'image/x-icon',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	js: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	map: 'application/json; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	mp3: 'audio/mpeg',
	mp4: 'video/mp4',
	oga: 'audio/ogg',
	ogg: 'audio/ogg',
	ogv: 'video/ogg',
	otf: 'font/otf',
	pdf: 'application/pdf',
	png: 'image/png',
	svg: 'image/svg+xml; charset=utf-8',
	ttf: 'font/ttf',
	txt: 'text/plain; charset=utf-8',
	wasm: 'application/wasm',
	wav: 'audio/wav',
	webm: 'video/webm',
	webmanifest: 'application/manifest+json; charset=utf-8',
	webp: 'image/webp',
	woff: 'font/woff',
	woff2: 'font/woff2',
	xml: 'application/xml; charset=utf-8',
}

export function inferDevAssetContentType(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? ''
	const separator = name.lastIndexOf('.')
	const extension =
		separator <= 0 ? '' : name.slice(separator + 1).toLowerCase()
	return contentTypesByExtension[extension] ?? 'application/octet-stream'
}
