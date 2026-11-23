import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import {
	packageAppClientModuleNamePattern,
	packageAppVersionAssetName,
} from './package-app-client-module-name.ts'

/**
 * Pure helpers for `package.json#kody.app.assets`: the static directory the
 * platform serves as-is under `<appBasePath>/_assets/`. Kept free of Worker
 * bindings so publish checks and the serve path share one definition of
 * which directories and asset paths are acceptable.
 */

/** Directories that never make sense as a public static root. */
const reservedAssetsDirectories = new Set(['.', 'node_modules'])

function hasTraversalSegment(path: string) {
	return path.split('/').some((segment) => segment === '..' || segment === '.')
}

/**
 * Root-level asset names the platform answers before the directory, so a
 * file with one of these names could never be served: the version JSON, and
 * (when the app declares a client) anything shaped like the fingerprinted
 * module.
 */
function findReservedRootAssetNames(input: {
	assetsDirectory: string
	assetFiles: ReadonlyArray<string>
	clientDeclared: boolean
}) {
	const prefix = `${input.assetsDirectory}/`
	return input.assetFiles
		.map((path) => path.slice(prefix.length))
		.filter((relativePath) => !relativePath.includes('/'))
		.filter(
			(name) =>
				name === packageAppVersionAssetName ||
				(input.clientDeclared && packageAppClientModuleNamePattern.test(name)),
		)
}

export function validatePackageAppAssetsDirectory(input: {
	assetsDirectory: string | null
	sourceFiles: Record<string, string>
	/** Whether the manifest declares `kody.app.client`. */
	clientDeclared?: boolean
}): { ok: true; message: string } | { ok: false; message: string } {
	const { assetsDirectory } = input
	if (assetsDirectory == null) {
		return { ok: true, message: 'No kody.app.assets directory declared.' }
	}
	if (
		reservedAssetsDirectories.has(assetsDirectory) ||
		assetsDirectory.startsWith('node_modules/') ||
		hasTraversalSegment(assetsDirectory)
	) {
		return {
			ok: false,
			message: `package.json#kody.app.assets must name a subdirectory of the package (got "${assetsDirectory}"). Use a dedicated folder such as "./public".`,
		}
	}
	const assetFiles = listPackageAppAssetFiles(input)
	if (assetFiles.length === 0) {
		return {
			ok: false,
			message: `package.json#kody.app.assets points at "${assetsDirectory}", but no files exist under that directory. Add the static files or remove the field.`,
		}
	}
	const reserved = findReservedRootAssetNames({
		assetsDirectory,
		assetFiles,
		clientDeclared: input.clientDeclared === true,
	})
	if (reserved.length > 0) {
		return {
			ok: false,
			message: `package.json#kody.app.assets contains root file(s) the platform answers itself under /_assets/ and would never serve: ${reserved
				.map((name) => `"${assetsDirectory}/${name}"`)
				.join(
					', ',
				)}. "${packageAppVersionAssetName}" is the platform version JSON and "client.<16-char-hash>.js" is the compiled kody.app.client module; rename the file or move it into a subdirectory.`,
		}
	}
	return {
		ok: true,
		message: `kody.app.assets serves ${assetFiles.length} file(s) from "${assetsDirectory}".`,
	}
}

/** Workspace paths of every file under the assets directory. */
export function listPackageAppAssetFiles(input: {
	assetsDirectory: string | null
	sourceFiles: Record<string, string>
}) {
	if (input.assetsDirectory == null) return []
	const prefix = `${input.assetsDirectory}/`
	return Object.keys(input.sourceFiles)
		.map((path) => normalizePackageWorkspacePath(path))
		.filter((path) => path.startsWith(prefix) && path.length > prefix.length)
		.sort((left, right) => left.localeCompare(right))
}

/**
 * Map a request path under `/_assets/` back to a workspace file inside the
 * assets directory. Rejects traversal, empty segments, and backslashes so a
 * request can never escape the declared directory, and dot-files and
 * dot-folders (`.env`, `.dev.vars`, `.git/`) so a secret file committed under
 * the assets directory is never served. `.well-known/` stays servable.
 */
export function resolvePackageAppAssetSourcePath(input: {
	assetsDirectory: string
	relativePath: string
}) {
	const relativePath = input.relativePath
	if (
		relativePath.length === 0 ||
		relativePath.includes('\\') ||
		relativePath.includes('\0')
	) {
		return null
	}
	const segments = relativePath.split('/')
	if (
		segments.some(
			(segment) =>
				segment.length === 0 ||
				(segment.startsWith('.') && segment !== '.well-known'),
		)
	) {
		return null
	}
	return `${input.assetsDirectory}/${segments.join('/')}`
}

const assetContentTypesByExtension: Record<string, string> = {
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

export function inferPackageAppAssetContentType(path: string) {
	const name = path.split('/').pop() ?? ''
	const separator = name.lastIndexOf('.')
	const extension =
		separator <= 0 ? '' : name.slice(separator + 1).toLowerCase()
	return assetContentTypesByExtension[extension] ?? 'application/octet-stream'
}
