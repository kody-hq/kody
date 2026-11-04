import { normalizePackageExportKey } from '#worker/package-registry/manifest.ts'
import { parseKodyPackageSpecifier } from './package-import-resolution.ts'
import {
	dirname,
	joinPath,
	normalizeWorkspaceModulePath,
} from './module-graph-path-basics.ts'

export {
	createRelativeImportSpecifier,
	dirname,
	joinPath,
	normalizeWorkspaceModulePath,
	relativePath,
	runtimeModulePath,
} from './module-graph-path-basics.ts'

export const publicRuntimeModulePath = '.__kody_virtual__/public-runtime.js'
export const packageRuntimeModulePrefix = '.__kody_virtual__/package-runtime'
export const packageManifestPath = 'package.json'
export const wranglerConfigPaths = [
	'wrangler.toml',
	'wrangler.json',
	'wrangler.jsonc',
]
export const rootSourcePrefix = '.__kody_root__'
export const packageSourcePrefix = '.__kody_packages__'
export const packageImportProxyPrefix = '.__kody_virtual__/imports'
/**
 * Publish offload: a bundle built outside Kody cloud imports each other Kody
 * package from here instead of inlining it. The build never supplies these
 * modules; Kody writes them when it commits the upload
 * (`#worker/publish-offload/link-dependencies.ts`).
 */
export const linkedPackageImportPrefix = '.__kody_linked__'
export const dynamicPackageImportProxyPrefix =
	'.__kody_virtual__/dynamic-imports'
export const dynamicPackageImportArtifactSegment = '.__kody_current__'
export const dynamicPackageImportSpecifierExportName =
	'__kodyDynamicPackageSpecifier'
export const dynamicPackageImportResolvedMarker = '__kodyDynamicPackageResolved'

export function resolveRelativeModulePath(fromPath: string, specifier: string) {
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
		return null
	}
	return normalizeWorkspaceModulePath(joinPath(dirname(fromPath), specifier))
}

export function encodePathKey(value: string) {
	return Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

export function encodePathKeyAsPath(value: string) {
	const encoded = encodePathKey(value)
	const chunks = encoded.match(/.{1,96}/g)
	return chunks?.join('/') ?? encoded
}

export function decodePathKey(value: string) {
	const bytes = value.match(/[0-9a-f]{2}/gi)
	if (!bytes || bytes.join('') !== value) return null
	try {
		return new TextDecoder().decode(
			new Uint8Array(bytes.map((byte) => Number.parseInt(byte, 16))),
		)
	} catch {
		return null
	}
}

export function linkedPackageImportPath(specifier: string) {
	return `${linkedPackageImportPrefix}/${createPackageProxyPathSegment(specifier)}.js`
}

export function createPackageProxyPathSegment(specifier: string) {
	const parsed = parseKodyPackageSpecifier(specifier)
	return encodePathKey(
		`${parsed.packageName}#${normalizePackageExportKey(parsed.exportName)}`,
	)
}

export function createPackageSpecifierFromProxyPath(modulePath: string) {
	const normalizedPath = normalizeWorkspaceModulePath(modulePath)
	const prefix = `${dynamicPackageImportProxyPrefix}/`
	const prefixIndex = normalizedPath.indexOf(prefix)
	if (prefixIndex === -1) return null
	const encodedSegment = normalizedPath
		.slice(prefixIndex + prefix.length)
		.split('/')[0]
		?.replace(/\.js$/, '')
	if (!encodedSegment) return null
	const decoded = decodePathKey(encodedSegment)
	const separator = decoded?.indexOf('#') ?? -1
	if (!decoded || separator === -1) return null
	const packageName = decoded.slice(0, separator)
	const exportName = decoded.slice(separator + 1)
	if (!packageName.startsWith('@')) return null
	const exportSuffix =
		exportName && exportName !== '.'
			? `/${exportName.replace(/^\.?\//, '')}`
			: ''
	return `capabilities:${packageName}${exportSuffix}`
}

const kodyVirtualModulePattern = /__kody_virtual__/i

function unescapeStringLiteralText(text: string) {
	return text.replace(
		/\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|\r\n|[\s\S])/gi,
		(match, braced?: string, unicode?: string, hex?: string) => {
			const code = braced ?? unicode ?? hex
			if (code != null) {
				const codePoint = Number.parseInt(code, 16)
				return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ''
			}
			const escaped = match.slice(1)
			return /^(?:\r\n|[\n\r\u2028\u2029])$/.test(escaped) ? '' : escaped
		},
	)
}

function percentDecodeText(text: string) {
	return text.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	)
}

/**
 * Whether one resolved module specifier addresses a bundler-generated virtual
 * module. The shared runtime exports stamp helpers that enter secret
 * authority for an arbitrary package id, so package imports must never reach
 * it. Callers pass parser-decoded specifier values (JS string escapes already
 * resolved); percent-encoding is decoded too so the check fails closed.
 */
export function specifierTargetsKodyVirtualModule(specifier: string) {
	return (
		kodyVirtualModulePattern.test(specifier) ||
		(specifier.includes('%') &&
			kodyVirtualModulePattern.test(percentDecodeText(specifier)))
	)
}

/**
 * Cheap pre-filter: whether file text names the virtual directory at all,
 * including JS/JSON string-escaped and percent-encoded spellings. Callers
 * treat a hit as "inspect the resolved specifiers", or as a rejection when
 * the file cannot be inspected precisely.
 */
export function textMentionsKodyVirtualModule(text: string) {
	if (kodyVirtualModulePattern.test(text)) return true
	const unescaped = text.includes('\\') ? unescapeStringLiteralText(text) : text
	if (unescaped !== text && kodyVirtualModulePattern.test(unescaped)) {
		return true
	}
	return (
		unescaped.includes('%') &&
		kodyVirtualModulePattern.test(percentDecodeText(unescaped))
	)
}

export function resolveWorkspaceSourceFilePath(input: {
	files: Record<string, string>
	path: string
}) {
	const basePath = normalizeWorkspaceModulePath(input.path)
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		`${basePath}.js`,
		`${basePath}.jsx`,
		`${basePath}.mts`,
		`${basePath}.cts`,
		`${basePath}.mjs`,
		`${basePath}.cjs`,
		joinPath(basePath, 'index.ts'),
		joinPath(basePath, 'index.tsx'),
		joinPath(basePath, 'index.js'),
		joinPath(basePath, 'index.jsx'),
		joinPath(basePath, 'index.mts'),
		joinPath(basePath, 'index.cts'),
		joinPath(basePath, 'index.mjs'),
		joinPath(basePath, 'index.cjs'),
	]
	const substitutionBase = basePath.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
	if (substitutionBase !== basePath) {
		candidates.push(
			`${substitutionBase}.ts`,
			`${substitutionBase}.tsx`,
			`${substitutionBase}.mts`,
			`${substitutionBase}.cts`,
			`${substitutionBase}.mjs`,
			`${substitutionBase}.cjs`,
		)
	}
	return candidates.find((candidate) => input.files[candidate] != null) ?? null
}
