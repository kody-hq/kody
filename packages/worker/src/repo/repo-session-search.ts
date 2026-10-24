import {
	buildRepoSearchEmptyPatternCallerMessage,
	buildRepoSearchInvalidRegexCallerMessage,
} from './repo-session-caller-error.ts'
import {
	type RepoSearchFileMatch,
	type RepoSearchMatch,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoSessionSearchResult,
} from './types.ts'

const defaultRepoSearchLimit = 50
const maxRepoSearchBytes = 200_000
const maxRepoSearchRegexLength = 512
const maxExpandedGlobPatterns = 64
const maxBraceNestingDepth = 16
const obviousNestedQuantifierPattern =
	/\((?:[^()\\]|\\.)*[+*{][^)]*\)(?:[+*]|\{\d+(?:,\d*)?\})/

function normalizeSearchLimit(limit: number | undefined) {
	if (!Number.isFinite(limit)) return defaultRepoSearchLimit
	return Math.min(Math.max(Math.trunc(limit as number), 1), 200)
}

function escapeRegex(source: string) {
	return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Expand brace groups into concrete globs before calling Workspace.glob.
 *
 * @cloudflare/shell currently splices brace alternatives into one regex group
 * without converting nested wildcards, so a brace arm that still contains `*`
 * or `?` throws "SyntaxError: Nothing to repeat". Expanding first keeps each
 * alternative on the wildcard-aware path.
 */
export function expandBraceGlobs(
	pattern: string,
	nestingDepth = 0,
): Array<string> {
	const open = pattern.indexOf('{')
	if (open === -1) return [pattern]
	if (nestingDepth >= maxBraceNestingDepth) {
		throw new Error(
			`repoSearch glob brace nesting exceeds ${maxBraceNestingDepth} levels.`,
		)
	}

	let braceDepth = 0
	let close = -1
	for (let index = open; index < pattern.length; index += 1) {
		const character = pattern[index]
		if (character === '{') braceDepth += 1
		else if (character === '}') {
			braceDepth -= 1
			if (braceDepth === 0) {
				close = index
				break
			}
		}
	}
	if (close === -1) return [pattern]

	const prefix = pattern.slice(0, open)
	const suffix = pattern.slice(close + 1)
	const alternatives: Array<string> = []
	let alternativeStart = open + 1
	braceDepth = 0
	for (let index = open + 1; index < close; index += 1) {
		const character = pattern[index]
		if (character === '{') braceDepth += 1
		else if (character === '}') braceDepth -= 1
		else if (character === ',' && braceDepth === 0) {
			alternatives.push(pattern.slice(alternativeStart, index))
			alternativeStart = index + 1
		}
	}
	alternatives.push(pattern.slice(alternativeStart, close))

	const expanded: Array<string> = []
	for (const alternative of alternatives) {
		for (const candidate of expandBraceGlobs(
			`${prefix}${alternative}${suffix}`,
			nestingDepth + 1,
		)) {
			expanded.push(candidate)
			if (expanded.length > maxExpandedGlobPatterns) {
				throw new Error(
					`repoSearch glob expands to more than ${maxExpandedGlobPatterns} patterns.`,
				)
			}
		}
	}
	return expanded
}

async function globWorkspaceFiles(input: {
	workspace: {
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
	}
	pattern: string
}): Promise<Array<{ path: string; type: string }>> {
	const patterns = expandBraceGlobs(input.pattern)
	if (patterns.length === 1) {
		const [onlyPattern] = patterns
		if (onlyPattern === undefined) return []
		return input.workspace.glob(onlyPattern)
	}

	const byPath = new Map<string, { path: string; type: string }>()
	for (const pattern of patterns) {
		const entries = await input.workspace.glob(pattern)
		for (const entry of entries) {
			byPath.set(entry.path, entry)
		}
	}
	return [...byPath.values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	)
}

function assertSafeRepoSearchRegex(pattern: string) {
	if (pattern.length > maxRepoSearchRegexLength) {
		throw new Error(
			`repoSearch regex patterns must be ${maxRepoSearchRegexLength} characters or fewer.`,
		)
	}
	if (obviousNestedQuantifierPattern.test(pattern)) {
		throw new Error(
			'repoSearch rejected an unsafe regex pattern with nested quantifiers.',
		)
	}
}

function normalizeSearchQuery(input: {
	pattern: string
	mode?: RepoSearchMode
}) {
	const pattern = input.pattern.trim()
	if (!pattern) {
		// Caller-correctable input. Keep the stable prefix so MCP can classify
		// this after DO RPC loses Error subclass identity. KODY-BA.
		throw new Error(buildRepoSearchEmptyPatternCallerMessage())
	}
	return {
		query: pattern,
		regex: input.mode === 'regex',
	}
}

function compileSearchMatcher(input: {
	query: string
	regex: boolean
	caseSensitive: boolean
}) {
	const flags = input.caseSensitive ? 'g' : 'gi'
	const pattern = input.regex ? input.query : escapeRegex(input.query)
	if (input.regex) {
		assertSafeRepoSearchRegex(pattern)
	}
	try {
		return new RegExp(pattern, flags)
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unknown regex compilation error.'
		// Caller-supplied pattern failed JS RegExp compilation (often Python/PCRE
		// inline flags). Keep the stable prefix so MCP can classify this as a
		// caller error after DO RPC loses Error subclass identity.
		throw new Error(buildRepoSearchInvalidRegexCallerMessage(message))
	}
}

function searchInText(input: {
	content: string
	matcher: RegExp
	contextBefore: number
	contextAfter: number
	maxMatches: number
}) {
	const inputTruncated = input.content.length > maxRepoSearchBytes
	// Bound regex work so a single pathological search cannot monopolize the DO.
	const source = inputTruncated
		? input.content.slice(0, maxRepoSearchBytes)
		: input.content
	const matcher = input.matcher
	// Reused across files; early truncation can leave lastIndex mid-string.
	matcher.lastIndex = 0
	const lines = source.split('\n')
	const lineOffsets: number[] = []
	let offset = 0
	for (const line of lines) {
		lineOffsets.push(offset)
		offset += line.length + 1
	}
	const matches: Array<{
		line: number
		column: number
		match: string
		lineText: string
		beforeLines?: string[]
		afterLines?: string[]
	}> = []
	let truncated = false
	for (const match of source.matchAll(matcher)) {
		if (matches.length >= input.maxMatches) {
			truncated = true
			break
		}
		const index = match.index ?? 0
		let lineIndex = 0
		for (let candidate = 0; candidate < lineOffsets.length; candidate += 1) {
			const candidateOffset = lineOffsets[candidate]
			if (candidateOffset === undefined) break
			if (candidateOffset > index) break
			lineIndex = candidate
		}
		const lineStart = lineOffsets[lineIndex] ?? 0
		const column = index - lineStart + 1
		const lineText = lines[lineIndex] ?? ''
		const beforeStart = Math.max(0, lineIndex - input.contextBefore)
		const afterEnd = Math.min(lines.length, lineIndex + input.contextAfter + 1)
		matches.push({
			line: lineIndex + 1,
			column,
			match: match[0] ?? '',
			lineText,
			beforeLines: lines.slice(beforeStart, lineIndex),
			afterLines: lines.slice(lineIndex + 1, afterEnd),
		})
	}
	return {
		matches,
		truncated: truncated || inputTruncated,
	}
}

export async function searchRepoWorkspace(input: {
	workspace: {
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
		readFile(path: string): Promise<string | null>
	}
	root: string
	pattern: string
	mode?: RepoSearchMode
	glob?: string | null
	caseSensitive?: boolean
	before?: number
	after?: number
	limit?: number
	outputMode?: RepoSearchOutputMode
	toExternalPath(path: string): string
}): Promise<RepoSessionSearchResult> {
	const search = normalizeSearchQuery({
		pattern: input.pattern,
		mode: input.mode,
	})
	// Validate/compile before scanning so invalid regex fails even when the
	// workspace has no readable files.
	const matcher = compileSearchMatcher({
		query: search.query,
		regex: search.regex,
		caseSensitive: input.caseSensitive ?? false,
	})
	const globPattern =
		input.glob?.trim() ||
		`${input.root.replace(/\/+$/, '')}/**/*.{ts,tsx,js,jsx,json,md,css}`
	const files = await globWorkspaceFiles({
		workspace: input.workspace,
		pattern: globPattern,
	})
	const matchMap = new Map<string, RepoSearchFileMatch>()
	const outputMode = input.outputMode ?? 'content'
	let remaining = normalizeSearchLimit(input.limit)
	let totalMatches = 0
	let truncated = false
	for (const file of files) {
		if (remaining <= 0) break
		if (file.type !== 'file') continue
		const content = await input.workspace.readFile(file.path)
		if (content == null) continue
		const result = searchInText({
			content,
			matcher,
			contextBefore: input.before ?? 0,
			contextAfter: input.after ?? 0,
			maxMatches: remaining,
		})
		const matches = result.matches
		if (matches.length === 0) continue
		totalMatches += matches.length
		remaining = Math.max(0, remaining - matches.length)
		truncated ||= result.truncated || remaining === 0
		matchMap.set(file.path, {
			path: input.toExternalPath(file.path),
			matches:
				outputMode === 'files'
					? []
					: matches.map<RepoSearchMatch>((match) => ({
							line: match.line,
							column: match.column,
							match: match.match,
							lineText: match.lineText,
							beforeLines: match.beforeLines ?? [],
							afterLines: match.afterLines ?? [],
						})),
		})
	}
	const filesWithMatches = [...matchMap.values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	)
	return {
		files: filesWithMatches,
		totalFiles: filesWithMatches.length,
		totalMatches,
		outputMode,
		truncated,
	}
}
