import ignore from 'ignore'

/**
 * Gitignore-syntax file at the package source root listing paths publish
 * checks never read: not credential-scanned, linted, typechecked, bundled,
 * or kept in the published snapshot. Runtime code stays safe because an
 * ignored file that an entry point imports fails bundle validation.
 */
export const kodyIgnoreFileName = '.kodyignore'

const neverIgnored = new Set(['package.json', kodyIgnoreFileName])

/** Returns null when there is nothing to ignore. */
export function createKodyIgnoreMatcher(
	content: string | null | undefined,
): ((relativePath: string) => boolean) | null {
	if (content == null || content.trim() === '') return null
	const matcher = ignore().add(content)
	return (relativePath) => {
		const path = relativePath.replace(/^\/+/, '')
		if (path === '' || neverIgnored.has(path)) return false
		try {
			return matcher.ignores(path)
		} catch {
			return false
		}
	}
}

/**
 * Drops `.kodyignore` matches under `sourceRoot` from a repo-rooted (or,
 * with an empty root, package-relative) file map. Paths outside the source
 * root are kept.
 */
export function omitKodyIgnoredFiles<Value>(
	files: Record<string, Value>,
	sourceRoot = '',
): Record<string, Value> {
	const trimmed = sourceRoot.replace(/^(?:\.\/|\/)+|\/+$/g, '')
	const root = trimmed === '.' ? '' : trimmed
	const prefix = root === '' ? '' : `${root}/`
	const ignoreFile = files[`${prefix}${kodyIgnoreFileName}`]
	const isIgnored = createKodyIgnoreMatcher(
		typeof ignoreFile === 'string' ? ignoreFile : null,
	)
	if (!isIgnored) return files
	const kept: Record<string, Value> = {}
	for (const [path, value] of Object.entries(files)) {
		const relative = path.replace(/^\/+/, '')
		if (prefix !== '' && !relative.startsWith(prefix)) {
			kept[path] = value
			continue
		}
		if (!isIgnored(relative.slice(prefix.length))) kept[path] = value
	}
	return kept
}
