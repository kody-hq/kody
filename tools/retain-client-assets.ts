import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import path from 'node:path'

const retentionMs = 7 * 24 * 60 * 60 * 1_000
/**
 * Retained builds younger than this are never evicted for the asset budget:
 * open tabs and the deploys just before this one keep every chunk they load.
 */
const minRetentionMs = 24 * 60 * 60 * 1_000
/** Headroom under the Workers static asset file limit for non-hashed files. */
const maxRetainedAssets = 19_000
const hashedAsset =
	/^.+-[\w-]{8,}\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|ico)$/

/** Keep open tabs' immutable imports available across production deployments. */
export function retainClientAssets({
	clientDirectory,
	previousDirectory,
	archiveDirectory,
	now = Date.now(),
	maxAssets = maxRetainedAssets,
}: {
	clientDirectory: string
	previousDirectory: string
	archiveDirectory: string
	now?: number
	/** Most hashed files one deploy may carry (current build plus retained). */
	maxAssets?: number
}) {
	const current = path.join(clientDirectory, 'assets')
	const previous = path.join(previousDirectory, 'assets')
	const manifestPath = path.join(previousDirectory, 'manifest.json')
	const timestamps: Record<string, number> = {}
	if (existsSync(previousDirectory) && !existsSync(manifestPath)) {
		throw new Error('Retained client asset archive is missing its manifest')
	}
	if (existsSync(manifestPath)) {
		const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
		if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
			throw new Error('Invalid retained client asset manifest')
		}
		for (const [name, timestamp] of Object.entries(manifest)) {
			if (
				path.basename(name) !== name ||
				!hashedAsset.test(name) ||
				typeof timestamp !== 'number' ||
				!Number.isFinite(timestamp) ||
				timestamp > now
			) {
				throw new Error('Invalid retained client asset entry')
			}
			if (now - timestamp <= retentionMs) timestamps[name] = timestamp
		}
	}
	const fresh = new Set(
		readdirSync(current).filter((name) => hashedAsset.test(name)),
	)
	for (const name of fresh) timestamps[name] = now
	if (fresh.size > maxAssets) {
		throw new Error('Retained assets approach the Workers static asset limit')
	}
	// Frequent deploys can retain more than the asset budget within the
	// retention window. Drop the oldest builds first, a whole build at a time
	// (its files share one timestamp), so a kept chunk never loses a
	// dependency from its own build. The current build always ships in full,
	// and builds inside the minimum retention window are never dropped: if
	// they do not fit, fail the deploy instead of breaking recent pages.
	const builds = new Map<number, Array<string>>()
	for (const [name, timestamp] of Object.entries(timestamps)) {
		if (fresh.has(name)) continue
		builds.set(timestamp, [...(builds.get(timestamp) ?? []), name])
	}
	let budget = maxAssets - fresh.size
	let evicting = false
	let evictedBuilds = 0
	let evictedAssets = 0
	for (const timestamp of [...builds.keys()].sort((a, b) => b - a)) {
		const names = builds.get(timestamp) ?? []
		if (!evicting && names.length <= budget) {
			budget -= names.length
			continue
		}
		if (now - timestamp < minRetentionMs) {
			throw new Error(
				'Retained assets approach the Workers static asset limit within the minimum retention window',
			)
		}
		evicting = true
		evictedBuilds += 1
		evictedAssets += names.length
		for (const name of names) delete timestamps[name]
	}
	if (evictedAssets > 0) {
		console.info(
			`Dropped ${evictedAssets} retained client assets from ${evictedBuilds} build(s) older than ${minRetentionMs / 3_600_000}h to stay under the asset budget.`,
		)
	}
	for (const name of Object.keys(timestamps)) {
		const destination = path.join(current, name)
		const source = path.join(previous, name)
		if (!fresh.has(name)) {
			if (!lstatSync(source).isFile()) {
				throw new Error('Retained client asset must be a regular file')
			}
			copyFileSync(source, destination)
		} else {
			if (!lstatSync(destination).isFile()) {
				throw new Error('Client asset must be a regular file')
			}
			if (
				existsSync(source) &&
				!readFileSync(source).equals(readFileSync(destination))
			) {
				throw new Error('Immutable client asset changed without a new filename')
			}
		}
	}
	rmSync(archiveDirectory, { recursive: true, force: true })
	mkdirSync(path.join(archiveDirectory, 'assets'), { recursive: true })
	for (const name of Object.keys(timestamps)) {
		copyFileSync(
			path.join(current, name),
			path.join(archiveDirectory, 'assets', name),
		)
	}
	writeFileSync(
		path.join(archiveDirectory, 'manifest.json'),
		JSON.stringify(timestamps),
	)
}
