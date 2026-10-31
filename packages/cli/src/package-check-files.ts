/**
 * Collect a local package tree for `packageCheck` (the server publish checks
 * `kody dev check` runs). Uses the files git tracks or would add (not
 * ignored) when the package is in a git checkout, otherwise walks the package
 * root. Binary files are sent by path and byte size only: publish checks read
 * source text, but binaries still count toward size limits and
 * `kody.app.assets` (a PNG-only assets directory must not look empty).
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const skippedDirectories = new Set(['node_modules', '.git'])

export type PackageCheckFiles = {
	files: Record<string, string>
	/** Files that are not UTF-8 text: relative path to byte size. */
	binaryFiles: Record<string, number>
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

/**
 * Relative paths in the publish snapshot file set (git tracked + untracked
 * non-ignored, or a full walk when not in git). Same path set
 * {@link collectPackageCheckFiles} reads; does not load file contents.
 */
export async function listPackageCheckPaths(
	root: string,
): Promise<Array<string>> {
	const paths = (await listGitFiles(root)) ?? (await walkFiles(root))
	return paths
		.filter(
			(path) =>
				!path.split('/').some((segment) => skippedDirectories.has(segment)),
		)
		.sort()
}

/**
 * Bundle inputs (absolute) that are outside the package or not in the publish
 * snapshot path set. Returned paths are package-root-relative with `/`.
 */
export function unpublishedBundleInputPaths(input: {
	absoluteInputs: ReadonlyArray<string>
	packageRoot: string
	snapshotPaths: ReadonlySet<string>
}): Array<string> {
	const missing: Array<string> = []
	for (const absolute of input.absoluteInputs) {
		const rel = relative(input.packageRoot, absolute)
		if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
			missing.push(rel.split(sep).join('/') || absolute)
			continue
		}
		const posix = rel.split(sep).join('/')
		if (!input.snapshotPaths.has(posix)) {
			missing.push(posix)
		}
	}
	return missing
}

/**
 * Message when a local bundle imports a file that will not be in the published
 * git snapshot (gitignored or untracked-and-ignored).
 */
export function formatUnpublishedBundleInputMessage(
	relativePath: string,
	options?: { hasPrebuild?: boolean },
): string {
	const base = `${relativePath} is imported but will not be in the published snapshot (gitignored or untracked). Commit it, or generate it somewhere publish can see.`
	if (options?.hasPrebuild === true) {
		return `${base} Note: kody.dev.prebuild runs only in \`kody dev\`; publish builds the git snapshot, so commit generated output.`
	}
	return base
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

export async function collectPackageCheckFiles(
	root: string,
): Promise<PackageCheckFiles> {
	const paths = await listPackageCheckPaths(root)
	const files: Record<string, string> = {}
	const binaryFiles: Record<string, number> = {}
	for (const path of paths) {
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
			binaryFiles[path] = bytes.byteLength
		}
	}
	return { files, binaryFiles }
}
