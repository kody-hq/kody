export function fileAssetUrl(
	orgSlug: string,
	fileId: string,
	revisionId?: string | null,
	download = false,
) {
	const query = new URLSearchParams()
	if (revisionId) query.set('revision', revisionId)
	if (download) query.set('download', 'true')
	return `/file-assets/${encodeURIComponent(orgSlug)}/${encodeURIComponent(fileId)}${query.size ? '?' + query : ''}`
}
export function parseFileRange(
	value: string | null,
	size: number,
): { offset: number; length: number } | null | false {
	if (!value) return null
	const match = /^bytes=(\d*)-(\d*)$/.exec(value)
	if (!match || (!match[1] && !match[2]) || size === 0) return false
	const start = match[1]
		? Number(match[1])
		: Math.max(0, size - Number(match[2]))
	const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start >= size ||
		end < start
	)
		return false
	return { offset: start, length: Math.min(end, size - 1) - start + 1 }
}
const fileAssetCsp =
	"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
export function inlineFileType(type: string) {
	return (
		type === 'application/pdf' ||
		/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(type) ||
		/^(audio|video)\/[a-z0-9.+-]+$/.test(type)
	)
}

export function fileAssetPolicy(type: string | null) {
	if (type === 'image/svg+xml')
		return fileAssetCsp + '; img-src data: blob:; sandbox'
	// Chromium's built-in PDF viewer embeds the PDF within its document.
	if (type === 'application/pdf')
		return fileAssetCsp + "; object-src 'self'; style-src 'unsafe-inline'"
	return fileAssetCsp
}

export const assetCacheControls = [
	'no-store',
	'public, max-age=60',
	'public, max-age=300',
	'public, max-age=3600',
] as const

export type FileAssetSettings = {
	cacheControl: (typeof assetCacheControls)[number]
	disposition: 'inline' | 'attachment'
}

export const defaultFileAssetSettings: FileAssetSettings = {
	cacheControl: 'no-store',
	disposition: 'inline',
}

export const signedAssetRouteToken = '0'.repeat(64)
