import { packageSourceFiles } from '#worker/credentials/credential-needs-closure.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const typeDeclarationFilePattern = /\.d\.[cm]?ts$/

/**
 * Identifier and capability names that mean package storage use when they
 * appear as code (not merely as text inside a string or template).
 */
const storageIdentifierPattern =
	/\b(packageStorage|storageQuery|storageExport)\b/g

/**
 * Dynamic property access that names storage even when the key is a string
 * literal: obj["packageStorage"], foo['storageQuery']. Kept even though the
 * name sits in quotes, because that is real access, not slide-deck prose.
 */
const storageBracketKeyPattern =
	/\[\s*(['"`])(packageStorage|storageQuery|storageExport)\1\s*\]/g

/**
 * Computed `kody[...]` / `kody?.[...]` access cannot be resolved statically,
 * so any occurrence in code still lists storage.
 */
const kodyBracketPattern = /\bkody\s*(?:\?\.)?\s*\[/g

export type PackageStorageDetectionPattern =
	| 'packageStorage'
	| 'storageQuery'
	| 'storageExport'
	| 'kodyBracket'
	| 'bracketKey'

export type PackageStorageMatch = {
	path: string
	line: number
	column: number
	pattern: PackageStorageDetectionPattern
	/** Short source excerpt around the match for agents and the approval page. */
	snippet: string
}

/**
 * Index ranges that are string or template *text* (not `${}` expressions).
 * Matches that fall entirely inside these ranges are treated as prose and do
 * not count as storage use, except bracket-key forms handled separately.
 */
function collectStringTextRanges(source: string): Array<{
	start: number
	end: number
}> {
	const ranges: Array<{ start: number; end: number }> = []
	let i = 0
	while (i < source.length) {
		const ch = source[i]!
		const next = source[i + 1]
		if (ch === '/' && next === '/') {
			i = source.indexOf('\n', i + 2)
			if (i < 0) break
			continue
		}
		if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2)
			i = end < 0 ? source.length : end + 2
			continue
		}
		if (ch === "'" || ch === '"') {
			const quote = ch
			const start = i + 1
			i++
			while (i < source.length) {
				if (source[i] === '\\') {
					i += 2
					continue
				}
				if (source[i] === quote) break
				i++
			}
			ranges.push({ start, end: i })
			i++
			continue
		}
		if (ch === '`') {
			i++
			let textStart = i
			while (i < source.length) {
				if (source[i] === '\\') {
					i += 2
					continue
				}
				if (source[i] === '`') {
					ranges.push({ start: textStart, end: i })
					i++
					break
				}
				if (source[i] === '$' && source[i + 1] === '{') {
					ranges.push({ start: textStart, end: i })
					i += 2
					let depth = 1
					while (i < source.length && depth > 0) {
						const c = source[i]!
						if (c === "'" || c === '"' || c === '`') {
							// Nested quotes inside ${}: recurse via simple skip of
							// that quoted span so braces inside strings do not
							// confuse depth. Conservative: treat nested template
							// content as non-code too via a short walk.
							const nestedQuote = c
							i++
							while (i < source.length) {
								if (source[i] === '\\') {
									i += 2
									continue
								}
								if (source[i] === nestedQuote) {
									i++
									break
								}
								if (
									nestedQuote === '`' &&
									source[i] === '$' &&
									source[i + 1] === '{'
								) {
									// Nested template expression: fall through by
									// counting braces only outside strings is hard;
									// advance one char and keep scanning.
									i++
									continue
								}
								i++
							}
							continue
						}
						if (c === '{') depth++
						else if (c === '}') depth--
						i++
					}
					textStart = i
					continue
				}
				i++
			}
			continue
		}
		i++
	}
	return ranges
}

function isInsideRanges(
	index: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	return ranges.some((range) => index >= range.start && end <= range.end)
}

function lineAndColumn(source: string, index: number) {
	let line = 1
	let lineStart = 0
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === '\n') {
			line++
			lineStart = i + 1
		}
	}
	return { line, column: index - lineStart + 1 }
}

function snippetAround(source: string, index: number, length: number) {
	const from = Math.max(0, index - 40)
	const to = Math.min(source.length, index + length + 40)
	return source.slice(from, to).replace(/\s+/g, ' ').trim()
}

function pushMatch(
	matches: Array<PackageStorageMatch>,
	path: string,
	source: string,
	index: number,
	length: number,
	pattern: PackageStorageDetectionPattern,
) {
	const { line, column } = lineAndColumn(source, index)
	matches.push({
		path,
		line,
		column,
		pattern,
		snippet: snippetAround(source, index, length),
	})
}

/**
 * Find package-storage use sites in module source. Occurrences that sit
 * entirely inside string or template text are ignored (slide decks and docs
 * in `.generated.ts` blobs). Dynamic forms still count:
 * - `packageStorage` / `storageQuery` / `storageExport` as code identifiers
 * - `kody[` / `kody?.[` in code
 * - `["packageStorage"]`-style bracket keys (string key, real access)
 *
 * Residual risk accepted: `new Function("packageStorage()")` and similar
 * eval-of-string forms are not counted. Prefer missing those over treating
 * demo prose as a capability. Comments still count (false positive OK).
 */
export function findPackageStorageMatchesInSource(
	path: string,
	source: string,
): Array<PackageStorageMatch> {
	const matches: Array<PackageStorageMatch> = []
	const stringRanges = collectStringTextRanges(source)

	storageIdentifierPattern.lastIndex = 0
	for (const match of source.matchAll(storageIdentifierPattern)) {
		const index = match.index ?? 0
		const text = match[1] ?? match[0]!
		if (isInsideRanges(index, index + text.length, stringRanges)) continue
		pushMatch(
			matches,
			path,
			source,
			index,
			text.length,
			text as PackageStorageDetectionPattern,
		)
	}

	kodyBracketPattern.lastIndex = 0
	for (const match of source.matchAll(kodyBracketPattern)) {
		const index = match.index ?? 0
		const text = match[0]!
		if (isInsideRanges(index, index + text.length, stringRanges)) continue
		pushMatch(matches, path, source, index, text.length, 'kodyBracket')
	}

	// Bracket keys: the name is inside quotes, so string-range skipping would
	// drop them; scan the full source and keep these as dynamic access.
	storageBracketKeyPattern.lastIndex = 0
	for (const match of source.matchAll(storageBracketKeyPattern)) {
		const index = match.index ?? 0
		pushMatch(matches, path, source, index, match[0]!.length, 'bracketKey')
	}

	return matches
}

export function findPackageStorageMatchesInFiles(
	files: Record<string, string>,
): Array<PackageStorageMatch> {
	const matches: Array<PackageStorageMatch> = []
	for (const [path, content] of Object.entries(files)) {
		if (!scannableModuleFilePattern.test(path)) continue
		if (typeDeclarationFilePattern.test(path)) continue
		matches.push(...findPackageStorageMatchesInSource(path, content))
	}
	return matches
}

export function sourceFilesUsePackageStorage(
	files: Record<string, string>,
): boolean {
	return findPackageStorageMatchesInFiles(files).length > 0
}

/**
 * Whether a published package's source reaches its package storage bucket.
 * A missing source row or published source snapshot reads as true, so
 * approval never hides storage it could not rule out.
 */
export async function publishedPackageUsesStorage(input: {
	env: Env
	sourceId: string
	publishedCommit: string
}): Promise<boolean> {
	const matches = await findPublishedPackageStorageMatches(input)
	return matches === 'assumed' || matches.length > 0
}

/**
 * Storage matches for a published commit, or `'assumed'` when the published
 * snapshot could not be read (fail closed: treat as uses storage).
 */
export async function findPublishedPackageStorageMatches(input: {
	env: Env
	sourceId: string
	publishedCommit: string
}): Promise<Array<PackageStorageMatch> | 'assumed'> {
	const [source, snapshot] = await Promise.all([
		getEntitySourceById(input.env.APP_DB, input.sourceId),
		readPublishedSourceSnapshot({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
		}),
	])
	if (!source || !snapshot) return 'assumed'
	return findPackageStorageMatchesInFiles(
		packageSourceFiles({ source, files: snapshot.files }).files,
	)
}
