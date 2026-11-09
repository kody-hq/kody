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

function normalizeSourceRootPrefix(sourceRoot: string) {
	const trimmed = sourceRoot.replace(/^(?:\.\/|\/)+|\/+$/g, '')
	const root = trimmed === '.' ? '' : trimmed
	return root === '' ? '' : `${root}/`
}

/** Repo-rooted path of the `.kodyignore` file for `sourceRoot`. */
export function kodyIgnoreFilePath(sourceRoot = '') {
	return `${normalizeSourceRootPrefix(sourceRoot)}${kodyIgnoreFileName}`
}

/**
 * Matcher over repo-rooted (or, with an empty root, package-relative) paths
 * for the `.kodyignore` at `sourceRoot`. Returns the ignored path relative
 * to the source root, or null when the path is kept. Paths outside the
 * source root are kept. Null when there is nothing to ignore.
 */
export function createSourceRootKodyIgnoreMatcher(input: {
	ignoreFileContent: string | null | undefined
	sourceRoot?: string
}): ((path: string) => string | null) | null {
	const isIgnored = createKodyIgnoreMatcher(input.ignoreFileContent)
	if (!isIgnored) return null
	const prefix = normalizeSourceRootPrefix(input.sourceRoot ?? '')
	return (path) => {
		const relative = path.replace(/^\/+/, '')
		if (prefix !== '' && !relative.startsWith(prefix)) return null
		const sourceRelative = relative.slice(prefix.length)
		return isIgnored(sourceRelative) ? sourceRelative : null
	}
}

/**
 * Splits a repo-rooted (or package-relative) file map into what
 * `.kodyignore` under `sourceRoot` keeps and the source-root-relative paths
 * it drops. Paths outside the source root are kept.
 */
export function partitionKodyIgnoredFiles<Value>(
	files: Record<string, Value>,
	sourceRoot = '',
): { kept: Record<string, Value>; ignoredPaths: Array<string> } {
	const ignoreFile = files[kodyIgnoreFilePath(sourceRoot)]
	const ignoredPath = createSourceRootKodyIgnoreMatcher({
		ignoreFileContent: typeof ignoreFile === 'string' ? ignoreFile : null,
		sourceRoot,
	})
	if (!ignoredPath) return { kept: files, ignoredPaths: [] }
	const kept: Record<string, Value> = {}
	const ignoredPaths: Array<string> = []
	for (const [path, value] of Object.entries(files)) {
		const ignored = ignoredPath(path)
		if (ignored === null) kept[path] = value
		else ignoredPaths.push(ignored)
	}
	return { kept, ignoredPaths }
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
	return partitionKodyIgnoredFiles(files, sourceRoot).kept
}
