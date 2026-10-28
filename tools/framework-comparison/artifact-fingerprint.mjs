import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

export function artifactFingerprint(root) {
	const directory = join(root, 'dist')
	const walk = (path) =>
		readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? walk(join(path, entry.name))
				: [join(path, entry.name)],
		)
	const files = walk(directory)
		.filter((path) => /\.(?:js|css)$/.test(path))
		.sort()
	if (!files.length) throw new Error(`No built JS/CSS under ${directory}`)
	const hash = createHash('sha256')
	for (const file of files)
		hash
			.update(relative(directory, file))
			.update('\0')
			.update(createHash('sha256').update(readFileSync(file)).digest('hex'))
			.update('\n')
	return { files: files.length, sha256: hash.digest('hex') }
}
