/**
 * Collect a local package tree for `packageCheck` (the server publish checks
 * `kody dev check` runs). Uses the files git tracks or would add (not
 * ignored) when the package is in a git checkout, otherwise walks the package root. Binary files are left
 * out: publish checks read source text, and binaries only count toward size
 * limits.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const skippedDirectories = new Set(['node_modules', '.git'])

export type PackageCheckFiles = {
	files: Record<string, string>
	/** Relative paths left out because they are not UTF-8 text. */
	skippedBinary: Array<string>
}

async function listGitFiles(root: string): Promise<Array<string> | null> {
	try {
		const { stdout } = await execFileAsync(
			'git',
			['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
			{ cwd: root, maxBuffer: 64 * 1024 * 1024 },
		)
		return stdout.split('\0').filter((path) => path.length > 0)
	} catch {
		return null
	}
}

async function walkFiles(root: string, dir = root): Promise<Array<string>> {
	const entries = await readdir(dir, { withFileTypes: true })
	const files: Array<string> = []
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (skippedDirectories.has(entry.name)) continue
			files.push(...(await walkFiles(root, join(dir, entry.name))))
		} else if (entry.isFile()) {
			files.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
		}
	}
	return files
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

export async function collectPackageCheckFiles(
	root: string,
): Promise<PackageCheckFiles> {
	const paths = (await listGitFiles(root)) ?? (await walkFiles(root))
	const files: Record<string, string> = {}
	const skippedBinary: Array<string> = []
	for (const path of paths.sort()) {
		if (path.split('/').some((segment) => skippedDirectories.has(segment))) {
			continue
		}
		let bytes: Buffer
		try {
			bytes = await readFile(join(root, path))
		} catch {
			// Tracked but deleted in the working tree: git would not push it.
			continue
		}
		try {
			files[path] = utf8.decode(bytes)
		} catch {
			skippedBinary.push(path)
		}
	}
	return { files, skippedBinary }
}
