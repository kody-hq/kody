// Drops (`unlink`) or recreates (`link`) the node_modules workspace links that
// package-lock.json lists, the way npm makes them: junctions on Windows,
// relative directory symlinks elsewhere.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const mode = process.argv[2]
if (mode !== 'link' && mode !== 'unlink') {
	throw new Error('Usage: node workspace-links.mjs <link|unlink>')
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
for (const [path, entry] of Object.entries(lock.packages)) {
	if (!entry.link) continue
	if (mode === 'unlink') {
		if (!existsSync(path) && !isLink(path)) continue
		if (!isLink(path)) throw new Error(`${path} is not a workspace link`)
		unlinkSync(path)
	} else if (!isLink(path)) {
		if (existsSync(path)) throw new Error(`${path} exists and is not a link`)
		mkdirSync(dirname(path), { recursive: true })
		if (process.platform === 'win32') {
			symlinkSync(resolve(entry.resolved), path, 'junction')
		} else {
			symlinkSync(relative(dirname(path), entry.resolved), path, 'dir')
		}
	}
}

function isLink(path) {
	try {
		return lstatSync(path).isSymbolicLink()
	} catch {
		return false
	}
}
