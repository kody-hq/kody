/** Public asset namespaces plus Vite's generated bundle directory. */
const assetDirectories = new Set([
	'fonts',
	'images',
	'og',
	'feature-scenes',
	'assets',
])

/**
 * Asset probing is based on asset layout, not a second application route table.
 * Root files (including robots.txt) may have dynamic fallbacks after an asset
 * miss. Documents outside these asset namespaces go directly to Start.
 * The inventory test checks every public file so new asset folders are explicit.
 */
export function requestSkipsAssetProbe(pathname: string) {
	if (pathname === '/') return false
	const segments = pathname.split('/').filter(Boolean)
	const root = segments[0] ?? ''
	if (assetDirectories.has(root)) return false
	return !(segments.length === 1 && root.includes('.') && !root.startsWith('@'))
}
