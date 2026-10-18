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
const hashedAsset =
	/^.+-[\w-]{8,}\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|ico)$/

/** Keep open tabs' immutable imports available across production deployments. */
export function retainClientAssets({
	clientDirectory,
	previousDirectory,
	archiveDirectory,
	now = Date.now(),
}: {
	clientDirectory: string
	previousDirectory: string
	archiveDirectory: string
	now?: number
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
	if (Object.keys(timestamps).length > 19_000) {
		throw new Error('Retained assets approach the Workers static asset limit')
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
