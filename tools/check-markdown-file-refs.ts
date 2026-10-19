import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Markdown file-reference check.
 *
 * Inline code that names a repo file, and relative markdown links, must point
 * at a file in the tree. Fenced examples are not scanned. A code path is
 * checked only when its parent directory
 * exists, so an example tree that was never added (such as
 * `packages/mock-servers/acme/src/worker.ts`) is not a stale citation. A path
 * whose parent is in the repo but whose file is not (a rename or a move) fails.
 *
 * Generated Wrangler configs (`wrangler-*.generated.json` and anything under
 * `.wrangler/`) are referenced on purpose and are gitignored, so they are
 * ignored. Local `.env` files are ignored for the same reason. `.env.example`
 * is committed and is checked. A same-line absence claim (the word "no"
 * immediately before the code span) is ignored.
 */

export const markdownFileReferenceRoots = [
	'packages/',
	'docs/',
	'tools/',
	'e2e/',
	'.agents/',
	'.github/',
] as const

const skippedDirectories = new Set([
	'node_modules',
	'.git',
	'dist',
	'.wrangler',
	'.nx',
	'coverage',
	'playwright-report',
	'test-results',
	'.tmp',
])

const fenceLinePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/
const absenceClaimPattern = /\b(?:no|not|without|missing|nonexistent)\s+$/i

type OpenFence = {
	char: string
	length: number
}
const placeholderPattern = /NNNN|XXXX|kebab-name|\.\.\./
const generatedWranglerConfigPattern = /(^|\/)wrangler-[^/]*\.generated\.json$/

export type MarkdownFileReferenceKind = 'code' | 'link'

export type MarkdownFileReference = {
	file: string
	line: number
	repoPath: string
	kind: MarkdownFileReferenceKind
}

export type MarkdownFileRefIssue = {
	file: string
	line: number
	reference: string
	message: string
}

export type MarkdownFileRefCheckResult = {
	ok: boolean
	issues: Array<MarkdownFileRefIssue>
}

export type MarkdownFileRefLookup = {
	fileExists: (repoRelativePath: string) => boolean
	directoryExists: (repoRelativePath: string) => boolean
}

export function isIgnoredMarkdownFileReference(repoRelativePath: string) {
	const normalized = repoRelativePath.replaceAll('\\', '/')
	if (
		normalized === '.wrangler' ||
		normalized.startsWith('.wrangler/') ||
		normalized.includes('/.wrangler/')
	) {
		return true
	}
	if (generatedWranglerConfigPattern.test(normalized)) return true
	const base = normalized.slice(normalized.lastIndexOf('/') + 1)
	if (base === '.env') return true
	if (base.startsWith('.env.') && base !== '.env.example') return true
	if (placeholderPattern.test(normalized)) return true
	return false
}

export function collectMarkdownFileReferences(input: {
	relativePath: string
	content: string
}): Array<MarkdownFileReference> {
	const markdownFile = input.relativePath.replaceAll('\\', '/')
	const references: Array<MarkdownFileReference> = []
	const lines = input.content.split('\n')
	let openFence: OpenFence | null = null
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.replace(/\r$/, '') ?? ''
		const fence = fenceTransition(line, openFence)
		if (fence === 'open') {
			openFence = fenceMarker(line)
			continue
		}
		if (fence === 'close') {
			openFence = null
			continue
		}
		if (openFence) continue
		collectCodeReferences(markdownFile, index + 1, line, references)
		collectLinkReferences(markdownFile, index + 1, line, references)
	}
	return references
}

export function evaluateMarkdownFileReferences(input: {
	references: ReadonlyArray<MarkdownFileReference>
	lookup: MarkdownFileRefLookup
}): Array<MarkdownFileRefIssue> {
	const issues: Array<MarkdownFileRefIssue> = []
	for (const reference of input.references) {
		if (isIgnoredMarkdownFileReference(reference.repoPath)) continue
		if (input.lookup.fileExists(reference.repoPath)) continue
		if (!shouldReportMissing(reference, input.lookup)) continue
		issues.push({
			file: reference.file,
			line: reference.line,
			reference: reference.repoPath,
			message: `\`${reference.repoPath}\` does not exist.`,
		})
	}
	return issues
}

export async function checkMarkdownFileRefs(
	repoRoot: string,
): Promise<MarkdownFileRefCheckResult> {
	const references = await collectRepoMarkdownFileReferences(repoRoot)
	const stats = await prefetchReferenceStats(repoRoot, references)
	const issues = evaluateMarkdownFileReferences({
		references,
		lookup: {
			fileExists: (repoRelativePath) =>
				stats.get(repoRelativePath)?.isFile() === true,
			directoryExists: (repoRelativePath) =>
				stats.get(repoRelativePath)?.isDirectory() === true,
		},
	})
	return { ok: issues.length === 0, issues }
}

function fenceMarker(line: string): OpenFence | null {
	const match = fenceLinePattern.exec(line)
	const marker = match?.[2]
	if (!marker) return null
	const char = marker[0]
	if (!char) return null
	return { char, length: marker.length }
}

/**
 * CommonMark: a closer uses the same character and is at least as long as the
 * opener, with no info string. A shorter ``` inside a ```` fence stays inside.
 */
function fenceTransition(
	line: string,
	openFence: OpenFence | null,
): 'open' | 'close' | null {
	const match = fenceLinePattern.exec(line)
	const marker = match?.[2]
	if (!marker) return null
	const char = marker[0]
	if (char !== '`' && char !== '~') return null
	const rest = match?.[3] ?? ''
	if (!openFence) {
		if (char === '`' && rest.includes('`')) return null
		return 'open'
	}
	if (char !== openFence.char || marker.length < openFence.length) return null
	if (rest.trim() !== '') return null
	return 'close'
}

function shouldReportMissing(
	reference: MarkdownFileReference,
	lookup: MarkdownFileRefLookup,
) {
	switch (reference.kind) {
		case 'link':
			return true
		case 'code': {
			const parent = parentDirectory(reference.repoPath)
			if (parent === null) return false
			if (parent === '.') return true
			return lookup.directoryExists(parent)
		}
		default: {
			const exhaustive: never = reference.kind
			throw new Error(
				`Unhandled markdown file reference: ${String(exhaustive)}`,
			)
		}
	}
}

function collectCodeReferences(
	markdownFile: string,
	lineNumber: number,
	line: string,
	references: Array<MarkdownFileReference>,
) {
	for (const match of line.matchAll(/`([^`\n]+)`/g)) {
		const token = match[1]
		if (!token) continue
		const spanStart = match.index ?? 0
		if (isAbsenceClaim(line, spanStart)) continue
		const repoPath = repoPathForToken(markdownFile, normalizeToken(token))
		if (!repoPath) continue
		references.push({
			file: markdownFile,
			line: lineNumber,
			repoPath,
			kind: 'code',
		})
	}
}

function collectLinkReferences(
	markdownFile: string,
	lineNumber: number,
	line: string,
	references: Array<MarkdownFileReference>,
) {
	const withoutCode = line.replace(/`[^`\n]*`/g, (span) =>
		' '.repeat(span.length),
	)
	for (const match of withoutCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
		const token = match[1]
		if (!token) continue
		const repoPath = repoPathForToken(markdownFile, normalizeLinkToken(token), {
			bareRelative: true,
		})
		if (!repoPath) continue
		references.push({
			file: markdownFile,
			line: lineNumber,
			repoPath,
			kind: 'link',
		})
	}
}

function isAbsenceClaim(line: string, spanStart: number) {
	const before = line.slice(Math.max(0, spanStart - 48), spanStart)
	return absenceClaimPattern.test(before)
}

function normalizeToken(token: string) {
	let normalized = token.trim()
	if (!normalized || /\s/.test(normalized)) return null
	if (/[*?<>$|()[\]{}!]/.test(normalized)) return null
	if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null
	if (normalized.startsWith('#')) return null
	normalized = normalized.replace(/[?#].*$/, '')
	normalized = normalized.replace(/:\d+(?::\d+)?$/, '')
	if (!normalized.includes('/')) return null
	if (!/\.[A-Za-z0-9]{1,10}$/.test(normalized)) return null
	return normalized
}

function normalizeLinkToken(token: string) {
	let normalized = token.trim()
	if (!normalized || /\s/.test(normalized)) return null
	if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null
	if (normalized.startsWith('#')) return null
	// Site-root and protocol-relative URLs are not repo files.
	if (normalized.startsWith('/')) return null
	normalized = normalized.replace(/[?#].*$/, '')
	if (!normalized || normalized.endsWith('/')) return null
	if (!/\.[A-Za-z0-9]{1,10}$/.test(normalized)) return null
	return normalized
}

function repoPathForToken(
	markdownFile: string,
	token: string | null,
	options: { bareRelative?: boolean } = {},
) {
	if (!token) return null
	const normalized = token.replaceAll('\\', '/')
	const markdownDir = path.posix.dirname(markdownFile)
	let repoPath: string
	if (normalized.startsWith('./') || normalized.startsWith('../')) {
		repoPath = path.posix.normalize(path.posix.join(markdownDir, normalized))
	} else if (
		markdownFileReferenceRoots.some((prefix) => normalized.startsWith(prefix))
	) {
		repoPath = path.posix.normalize(normalized)
	} else if (options.bareRelative) {
		// Markdown resolves `checks.md` and `setup/checks.md` against the file.
		repoPath = path.posix.normalize(path.posix.join(markdownDir, normalized))
	} else {
		return null
	}
	if (
		repoPath === '..' ||
		repoPath.startsWith('../') ||
		path.posix.isAbsolute(repoPath)
	) {
		return null
	}
	return repoPath
}

function parentDirectory(repoRelativePath: string) {
	const index = repoRelativePath.lastIndexOf('/')
	if (index === -1) return '.'
	if (index === 0) return null
	return repoRelativePath.slice(0, index)
}

async function collectRepoMarkdownFileReferences(repoRoot: string) {
	const files = await listMarkdownFiles(repoRoot)
	const references: Array<MarkdownFileReference> = []
	for (const relativePath of files) {
		const content = await readFile(path.join(repoRoot, relativePath), 'utf8')
		references.push(...collectMarkdownFileReferences({ relativePath, content }))
	}
	return references
}

async function prefetchReferenceStats(
	repoRoot: string,
	references: ReadonlyArray<MarkdownFileReference>,
) {
	const stats = new Map<string, { isFile(): boolean; isDirectory(): boolean }>()
	const repoPaths = new Set<string>()
	for (const reference of references) {
		repoPaths.add(reference.repoPath)
		const parent = parentDirectory(reference.repoPath)
		if (parent && parent !== '.') repoPaths.add(parent)
	}
	await Promise.all(
		[...repoPaths].map(async (repoRelativePath) => {
			try {
				const result = await stat(path.join(repoRoot, repoRelativePath))
				stats.set(repoRelativePath, result)
			} catch {
				// Missing paths stay absent. The evaluator treats that as not existing.
			}
		}),
	)
	return stats
}

async function listMarkdownFiles(repoRoot: string) {
	const files: Array<string> = []
	await walkMarkdown(repoRoot, '', files)
	files.sort()
	return files
}

async function walkMarkdown(
	directory: string,
	relativeDirectory: string,
	files: Array<string>,
) {
	const entries = await readdir(directory, { withFileTypes: true })
	for (const entry of entries) {
		if (skippedDirectories.has(entry.name)) continue
		const relativePath = relativeDirectory
			? `${relativeDirectory}/${entry.name}`
			: entry.name
		const absolute = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			await walkMarkdown(absolute, relativePath, files)
			continue
		}
		if (!entry.isFile()) continue
		if (!/\.mdx?$/.test(entry.name)) continue
		files.push(relativePath.replaceAll('\\', '/'))
	}
}

export async function main(repoRoot: string = process.cwd()) {
	const result = await checkMarkdownFileRefs(repoRoot)
	if (result.ok) {
		console.log('Markdown file reference check passed.')
		return
	}
	console.error(
		[
			`Markdown file reference check failed (${String(result.issues.length)} issue(s)).`,
			'Inline repo paths and relative links must point at files in the tree.',
			'Generated wrangler configs (wrangler-*.generated.json) and local .env files are ignored.',
			'',
			...result.issues.map(
				(issue) => `${issue.file}:${String(issue.line)}: ${issue.message}`,
			),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
