import { snapshotStringToBytes } from '#universal/package-file-media.ts'
import { packageReadmeImageMaxBytes } from '#universal/package-readme-images.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

export const packageReadmeAssetCacheControl = 'public, max-age=3600'
export const packageReadmeAssetPrivateCacheControl = 'private, no-store'
const packageReadmeAssetSvgContentSecurityPolicy = "default-src 'none'; sandbox"

export type PackageReadmeImageContentType =
	| 'image/png'
	| 'image/jpeg'
	| 'image/webp'
	| 'image/gif'
	| 'image/svg+xml'

function readAscii(bytes: Uint8Array, offset: number, length: number) {
	return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function hasPrefix(bytes: Uint8Array, prefix: ReadonlyArray<number>) {
	return (
		bytes.byteLength >= prefix.length &&
		prefix.every((byte, index) => bytes[index] === byte)
	)
}

function extensionOfPath(path: string) {
	const name = path.split('/').pop() ?? ''
	const separator = name.lastIndexOf('.')
	if (separator <= 0 || separator === name.length - 1) return ''
	return name.slice(separator + 1).toLowerCase()
}

function isSvgMarkup(bytes: Uint8Array) {
	const text = new TextDecoder('utf-8', { fatal: false })
		.decode(bytes)
		.replace(/^\uFEFF/, '')
		.trimStart()
	if (!text.startsWith('<svg') && !text.startsWith('<?xml')) return false
	if (/<script[\s>]/i.test(text)) return false
	return /<svg[\s>]/i.test(text)
}

/**
 * Require both an allowlisted extension and matching magic bytes so a
 * renamed `.js` or HTML file cannot be served as an image.
 */
export function sniffPackageReadmeImageContentType(
	bytes: Uint8Array,
	path: string,
): PackageReadmeImageContentType | null {
	if (bytes.byteLength === 0 || bytes.byteLength > packageReadmeImageMaxBytes) {
		return null
	}
	const extension = extensionOfPath(path)
	switch (extension) {
		case 'png':
			return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
				? 'image/png'
				: null
		case 'jpg':
		case 'jpeg':
			return hasPrefix(bytes, [0xff, 0xd8, 0xff]) ? 'image/jpeg' : null
		case 'webp':
			return bytes.byteLength >= 12 &&
				readAscii(bytes, 0, 4) === 'RIFF' &&
				readAscii(bytes, 8, 4) === 'WEBP'
				? 'image/webp'
				: null
		case 'gif':
			return hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
				hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
				? 'image/gif'
				: null
		case 'svg':
			return isSvgMarkup(bytes) ? 'image/svg+xml' : null
		default:
			return null
	}
}

async function readPackageReadmeAssetSnapshotBytes(input: {
	env: Env
	sourceId: string
	commit: string
	relativePath: string
}) {
	if (!input.env.BUNDLE_ARTIFACTS_KV) return null
	try {
		const published = await readPublishedSourceSnapshot({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: input.commit,
		})
		const publishedFile = published?.files[input.relativePath]
		if (publishedFile != null) {
			return snapshotStringToBytes(publishedFile, input.relativePath)
		}
	} catch {
		return null
	}
	return null
}

/**
 * Published or pinned image bytes. Prefer the git blob so rasters stay
 * byte-accurate; fall back to the published source snapshot the way
 * `/raw/` does when that blob is missing.
 */
export async function loadPackageReadmeAssetBytes(input: {
	env: Env
	sourceId: string
	commit: string
	relativePath: string
}) {
	if (!input.commit) return null
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (source?.repo_id) {
		try {
			const bytes = await readArtifactFileAtCommit({
				env: input.env,
				repoId: source.repo_id,
				commit: input.commit,
				filePath: input.relativePath,
			})
			if (bytes) return bytes
		} catch (error) {
			console.error(
				'package-readme-asset-load-failed',
				input.sourceId,
				input.relativePath,
				error,
			)
		}
	}
	return await readPackageReadmeAssetSnapshotBytes(input)
}

export function buildPackageReadmeAssetHeaders(input: {
	contentType: PackageReadmeImageContentType
	byteLength: number
	etag: string
	cacheControl: string
}) {
	const headers: Record<string, string> = {
		'Cache-Control': input.cacheControl,
		'Content-Length': String(input.byteLength),
		'Content-Type': input.contentType,
		'Cross-Origin-Resource-Policy': 'same-origin',
		ETag: input.etag,
		'X-Content-Type-Options': 'nosniff',
	}
	if (input.contentType === 'image/svg+xml') {
		headers['Content-Security-Policy'] =
			packageReadmeAssetSvgContentSecurityPolicy
		headers['Content-Type'] = 'image/svg+xml; charset=utf-8'
	}
	return headers
}
