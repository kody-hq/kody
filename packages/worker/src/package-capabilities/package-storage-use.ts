import { packageSourceFiles } from '#worker/credentials/credential-needs-closure.ts'
import { parseModuleSource } from '#worker/module-source.ts'
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

type AstNode = {
	type: string
	start?: number | null
	end?: number | null
	[key: string]: unknown
}

/**
 * Collect source ranges that are string / template / JSX text only. Uses
 * Babel so regex literals and JSX apostrophes cannot open a string range
 * that swallows later code. Returns null when the file does not parse:
 * callers must fail closed (do not skip any matches).
 */
function collectStringTextRanges(
	source: string,
): Array<{ start: number; end: number }> | null {
	let parsed: AstNode
	try {
		parsed = parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
	const ranges: Array<{ start: number; end: number }> = []
	walkAst(parsed, (node) => {
		if (
			node.type !== 'StringLiteral' &&
			node.type !== 'DirectiveLiteral' &&
			node.type !== 'TemplateElement' &&
			node.type !== 'JSXText'
		) {
			return
		}
		if (typeof node.start !== 'number' || typeof node.end !== 'number') return
		ranges.push({ start: node.start, end: node.end })
	})
	return ranges
}

function walkAst(node: AstNode, visit: (node: AstNode) => void) {
	visit(node)
	for (const [key, value] of Object.entries(node)) {
		if (
			key === 'loc' ||
			key === 'start' ||
			key === 'end' ||
			key === 'range' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'innerComments' ||
			key === 'comments'
		) {
			continue
		}
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === 'object' && 'type' in child) {
					walkAst(child as AstNode, visit)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && 'type' in value) {
			walkAst(value as AstNode, visit)
		}
	}
}

function isInsideRanges(
	index: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	return ranges.some((range) => index >= range.start && end <= range.end)
}

/**
 * True when this match should be treated as prose. Fail closed: when ranges
 * are null (parse failure), never skip.
 */
function isProseMatch(
	index: number,
	end: number,
	ranges: Array<{ start: number; end: number }> | null,
) {
	if (ranges === null) return false
	return isInsideRanges(index, end, ranges)
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
 * entirely inside string, template, or JSX text are ignored (slide decks and
 * docs in `.generated.ts` blobs). Dynamic forms still count:
 * - `packageStorage` / `storageQuery` / `storageExport` as code identifiers
 * - `kody[` / `kody?.[` in code
 * - `["packageStorage"]`-style bracket keys when the `[` is in code
 *
 * Parse failures fail closed: every regex hit counts (no prose skip).
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
		if (isProseMatch(index, index + text.length, stringRanges)) continue
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
		if (isProseMatch(index, index + text.length, stringRanges)) continue
		pushMatch(matches, path, source, index, text.length, 'kodyBracket')
	}

	// Bracket keys: the name is inside quotes by design. Skip only when the
	// entire `["packageStorage"]` span sits inside a larger string/template/
	// JSX text range (slide prose). Real code access stays.
	storageBracketKeyPattern.lastIndex = 0
	for (const match of source.matchAll(storageBracketKeyPattern)) {
		const index = match.index ?? 0
		const text = match[0]!
		if (isProseMatch(index, index + text.length, stringRanges)) continue
		pushMatch(matches, path, source, index, text.length, 'bracketKey')
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
