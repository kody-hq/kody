import { shouldStoreArtifactBlobAsLatin1 } from '#universal/package-file-media.ts'
import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'
import type { CrossScopeReference, LeftoverOriginReference } from './types.ts'

const kodyImportPattern = /kody:@([a-z0-9][a-z0-9._-]*)\//g
const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

function normalizePackageScope(scope: string) {
	return scope.trim().replace(/^@/, '').toLowerCase()
}

function getScopeFromScopedName(name: string) {
	const match = scopedPackageNamePattern.exec(name.trim())
	return match?.[1] ?? null
}

function addCrossScopeReference(
	seen: Set<string>,
	results: Array<CrossScopeReference>,
	input: CrossScopeReference,
) {
	const key = `${input.file}\0${input.specifier}`
	if (seen.has(key)) return
	seen.add(key)
	results.push(input)
}

const scopedTopicPattern = /^@([a-z0-9][a-z0-9._-]*)\/(.+)$/

/**
 * Map each changed scoped `kody.emits` topic to the fork's topic. A
 * topic named after the origin package (`@kody/github.issue.opened`) takes
 * the fork's scope and leaf (`@jane/my-github.issue.opened`); any other
 * topic keeps its body and takes the fork's scope. Reject a rename that
 * makes two distinct declarations share a topic.
 */
export function planForkedEmittedTopics(input: {
	topics: Array<string>
	originName: string | null
	targetName: string
}): Record<string, string> {
	const target = scopedPackageNamePattern.exec(input.targetName)
	if (!target) return {}
	const targetScope = target[1]!
	const targetLeaf = input.targetName.slice(target[0].length)
	const originLeaf = input.originName
		? input.originName.trim().replace(scopedPackageNamePattern, '')
		: null
	const renames: Record<string, string> = {}
	for (const topic of input.topics) {
		const match = scopedTopicPattern.exec(topic.trim())
		if (!match) continue
		const body = match[2]!
		const nextBody =
			originLeaf && body.startsWith(`${originLeaf}.`)
				? `${targetLeaf}${body.slice(originLeaf.length)}`
				: body
		const next = `@${targetScope}/${nextBody}`
		if (next !== topic) renames[topic] = next
	}
	const owners = new Map<string, string>()
	for (const topic of input.topics) {
		const next = renames[topic] ?? topic
		const other = owners.get(next)
		if (other != null && other !== topic) {
			throw new Error(
				`Forking as "${input.targetName}" would rename kody.emits topics "${other}" and "${topic}" to the same topic "${next}". Choose a different package name for the fork.`,
			)
		}
		owners.set(next, topic)
	}
	return renames
}

const regexSpecialChars = /[.*+?^${}()|[\]\\]/g

function escapeRegExp(text: string) {
	return text.replace(regexSpecialChars, '\\$&')
}

/**
 * The spellings of a scoped reference the fork rewrite follows. `@` is
 * written as is or URL-encoded (`%40`). `/` is written as is, escaped for a
 * regex literal or JSON (`\/`), escaped twice in a string that builds a regex
 * (`\\/`), or URL-encoded (`%2F`, `%2f`). The rewrite keeps whichever
 * spelling it found.
 */
const rewrittenAtForms = '@|%40'
const rewrittenSlashForms = String.raw`\\{0,2}/|%2[Ff]`

/**
 * A whole `@scope/name` ends where the next character cannot continue the
 * name: not a name character, an escaped hyphen, or a dot that starts a
 * topic body or a longer name (`@kody/github.issue`, `@kody\/github\.issue`,
 * `@kody/github._internal`).
 * A sentence-ending `.` and a regex `\.` before a delimiter still end it.
 */
const scopedNameEnd = String.raw`(?![A-Za-z0-9_-]|\\+-|\.[a-z0-9*_-]|\\+\.\\*[a-z0-9*_-])`

/**
 * The topic body is lower-dot-case, so a reference ends where the next
 * character cannot continue it (a sentence-ending `.` still ends it).
 */
const emittedTopicReferenceEnd = String.raw`(?![a-z0-9_-]|\\{0,2}\.[a-z0-9*])`

/**
 * Topic references in every rewritten spelling. Dots in the body may carry
 * the escape a regex gives them (`@kody\/github\.issue\.opened`); the fork's
 * topic keeps that escape.
 */
function rewriteEmittedTopicReferences(
	content: string,
	topicRenames: Record<string, string>,
) {
	let next = content
	for (const [origin, target] of Object.entries(topicRenames)) {
		const originParts = scopedTopicPattern.exec(origin)
		const targetParts = scopedTopicPattern.exec(target)
		if (!originParts || !targetParts) continue
		const originScope = originParts[1]!
		if (!next.includes(originScope)) continue
		const [firstSegment, ...restSegments] = originParts[2]!.split('.')
		const body =
			escapeRegExp(firstSegment!) +
			(restSegments.length > 0
				? String.raw`(\\{0,2})\.` +
					restSegments.map(escapeRegExp).join(String.raw`\3\.`)
				: '()')
		const targetScope = targetParts[1]!
		const targetBody = targetParts[2]!
		next = next.replace(
			new RegExp(
				`(${rewrittenAtForms})${escapeRegExp(originScope)}(${rewrittenSlashForms})${body}${emittedTopicReferenceEnd}`,
				'g',
			),
			(_match, at: string, slash: string, dotEscape: string) =>
				`${at}${targetScope}${slash}${targetBody.replaceAll('.', `${dotEscape}.`)}`,
		)
	}
	return next
}

/** `@kody/github.*` globs in prose follow the origin's own topic prefix. */
function withOwnTopicGlob(input: {
	topicRenames: Record<string, string>
	originName: string | null
	targetName: string
}) {
	const { originName, targetName } = input
	if (!originName || originName === targetName) return input.topicRenames
	const ownPrefix = `${originName}.`
	const usesOwnPrefix = Object.entries(input.topicRenames).some(
		([source, target]) =>
			source.startsWith(ownPrefix) && target.startsWith(`${targetName}.`),
	)
	return usesOwnPrefix
		? { ...input.topicRenames, [`${originName}.*`]: `${targetName}.*` }
		: input.topicRenames
}

export function rewritePackageManifestForFork(input: {
	manifestContent: string
	expectedPackageScope: string
	targetKodyId: string
}): {
	content: string
	targetName: string
	originName: string | null
	/**
	 * Changed emits topics and, when an own-prefix topic changes, its
	 * `@scope/leaf.*` glob. Pass this map to
	 * `rewriteForkedPackageSelfReferences` for text files.
	 */
	topicRenames: Record<string, string>
} {
	const parsed = JSON.parse(input.manifestContent) as Record<string, unknown>
	const originName =
		typeof parsed['name'] === 'string' && parsed['name'].trim()
			? parsed['name'].trim()
			: null
	const scope = normalizePackageScope(input.expectedPackageScope)
	const targetName = `@${scope}/${input.targetKodyId}`
	const previousKody =
		typeof parsed['kody'] === 'object' && parsed['kody'] != null
			? { ...(parsed['kody'] as Record<string, unknown>) }
			: {}
	// Authored `kody.id` is leftover identity (#1909). Forks keep other kody
	// fields but drop `id`; the parser derives the leaf from `name`.
	delete previousKody['id']
	const next = {
		...parsed,
		name: targetName,
		private: true,
		kody: previousKody,
	}
	const emits = previousKody['emits']
	const topicRenames = withOwnTopicGlob({
		topicRenames: planForkedEmittedTopics({
			topics:
				typeof emits === 'object' && emits != null && !Array.isArray(emits)
					? Object.keys(emits)
					: [],
			originName,
			targetName,
		}),
		originName,
		targetName,
	})
	return {
		content: rewriteEmittedTopicReferences(
			`${JSON.stringify(next, null, '\t')}\n`,
			topicRenames,
		),
		targetName,
		originName,
		topicRenames,
	}
}

export function scanCrossScopeReferences(input: {
	files: Record<string, string>
	expectedPackageScope: string
}): Array<CrossScopeReference> {
	const expectedScope = normalizePackageScope(input.expectedPackageScope)
	const isForeign = (scope: string) =>
		normalizePackageScope(scope) !== expectedScope
	const seen = new Set<string>()
	const results: Array<CrossScopeReference> = []

	for (const [file, content] of Object.entries(input.files)) {
		if (file === 'package.json') {
			try {
				const parsed = JSON.parse(content) as {
					kody?: { dependencies?: Array<string> | Record<string, string> }
				}
				for (const dependency of listKodyPackageDependencyNames(
					parsed.kody?.dependencies,
				)) {
					const dependencyScope = getScopeFromScopedName(dependency)
					if (dependencyScope != null && isForeign(dependencyScope)) {
						addCrossScopeReference(seen, results, {
							file,
							specifier: dependency,
						})
					}
				}
			} catch {
				// package.json is validated elsewhere before fork.
			}
		}

		for (const match of content.matchAll(kodyImportPattern)) {
			const importScope = match[1]
			if (importScope != null && isForeign(importScope)) {
				addCrossScopeReference(seen, results, {
					file,
					specifier: `kody:@${importScope}/`,
				})
			}
		}
	}

	return results.sort((left, right) => {
		const fileCompare = left.file.localeCompare(right.file)
		if (fileCompare !== 0) return fileCompare
		return left.specifier.localeCompare(right.specifier)
	})
}

const scopedOriginPattern =
	/^@([a-z0-9][a-z0-9._-]*)(?:\/([a-z0-9][a-z0-9._-]*))?$/

/**
 * Replace `origin` (`@scope/name`, or `@scope` with `end: 'scope'`) with
 * `next` in every file, in each spelling listed at `rewrittenSlashForms`,
 * keeping the spelling (`/@kody\/alpha/` becomes `/@jane\/alpha/`). A whole
 * name is replaced only where it ends at a name boundary, so `@kody/alpha`
 * never rewrites inside `@kody/alpha-beta` or `@kody/alpha2`. A bare scope is
 * replaced only where a package name follows.
 */
export function rewriteScopedReferences(input: {
	files: Record<string, string>
	origin: string
	next: string
	end: 'name' | 'scope'
}): Record<string, string> {
	const origin = scopedOriginPattern.exec(input.origin.trim())
	const next = scopedOriginPattern.exec(input.next.trim())
	if (!origin || !next || origin[0] === next[0]) {
		return { ...input.files }
	}
	const originScope = origin[1]!
	const originLeaf = origin[2]
	const nextScope = next[1]!
	const nextLeaf = next[2]
	const wholeName = input.end === 'name'
	if (wholeName && (originLeaf == null || nextLeaf == null)) {
		return { ...input.files }
	}
	const pattern = wholeName
		? new RegExp(
				`(${rewrittenAtForms})${escapeRegExp(originScope)}(${rewrittenSlashForms})${escapeRegExp(originLeaf!)}${scopedNameEnd}`,
				'g',
			)
		: new RegExp(
				`(${rewrittenAtForms})${escapeRegExp(originScope)}(?=${rewrittenSlashForms})`,
				'g',
			)
	const files: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.files)) {
		files[path] = content.includes(originScope)
			? content.replace(pattern, (_match, at: string, slash?: string) =>
					wholeName
						? `${at}${nextScope}${slash}${nextLeaf}`
						: `${at}${nextScope}`,
				)
			: content
	}
	return files
}

/**
 * Looser spellings the leftover scan recognizes but the rewrite leaves
 * alone: any number of backslashes, and `\u0040` / `\x40` / `\u002f` /
 * `\x2f` escapes. A backslash run is matched from its first backslash only,
 * so a long run costs one pass.
 */
const leftoverAtForms = String.raw`(?:(?<!\\)\\*@|%40|(?<!\\)\\+u0040|(?<!\\)\\+x40)`
const leftoverSlashForms = String.raw`(?:\\*/|%2[Ff]|\\+u002[Ff]|\\+x2[Ff])`
const leftoverNameEnd = String.raw`(?![A-Za-z0-9_-]|\\+-)`
const maxLeftoverOriginReferences = 50
const leftoverSnippetContext = 60
const leftoverSnippetMaxLength = 160

/** Match `text` with optional backslashes before its punctuation. */
function looseLiteral(text: string) {
	return text.replace(/[^a-z0-9]/g, (char) => `\\\\*${escapeRegExp(char)}`)
}

function leftoverSnippet(content: string, index: number, length: number) {
	const lineStart = content.lastIndexOf('\n', index - 1) + 1
	const lineBreak = content.indexOf('\n', index)
	const lineEnd = lineBreak === -1 ? content.length : lineBreak
	const line = content.slice(lineStart, lineEnd)
	if (line.trim().length <= leftoverSnippetMaxLength) return line.trim()
	return content
		.slice(
			Math.max(lineStart, index - leftoverSnippetContext),
			Math.min(lineEnd, index + length + leftoverSnippetContext),
		)
		.trim()
}

/**
 * After the fork rewrite, list what still names the origin: the origin
 * package name in any spelling (including ones the rewrite does not follow),
 * and, when the fork changes scope, escaped or encoded references to the
 * origin scope. A plain `@origin-scope/other-package` is an ordinary
 * dependency and is not listed here; `scanCrossScopeReferences` reports
 * those imports. Returns at most 50 entries, one per file line.
 */
export function scanLeftoverOriginReferences(input: {
	files: Record<string, string>
	originPackageName: string
	nextPackageName: string
}): Array<LeftoverOriginReference> {
	const origin = scopedOriginPattern.exec(input.originPackageName.trim())
	const next = scopedOriginPattern.exec(input.nextPackageName.trim())
	if (!origin || !next || origin[0] === next[0]) return []
	const originScope = origin[1]!
	const originLeaf = origin[2]
	if (originLeaf == null) return []
	const scopeReference = `${leftoverAtForms}${looseLiteral(originScope)}${leftoverSlashForms}`
	const pattern = new RegExp(
		`(${scopeReference})(${looseLiteral(originLeaf)}${leftoverNameEnd})?`,
		'g',
	)
	const plainScopeReference = `@${originScope}/`
	const scopeChanged = originScope !== next[1]
	const results: Array<LeftoverOriginReference> = []
	const paths = Object.keys(input.files).sort((left, right) =>
		left.localeCompare(right),
	)
	for (const file of paths) {
		const content = input.files[file]!
		if (isByteSnapshotFile(file, content)) continue
		let line = 1
		let scanned = 0
		let lastReportedLine = 0
		for (const match of content.matchAll(pattern)) {
			const namesOriginPackage = match[2] != null
			if (!namesOriginPackage) {
				if (!scopeChanged || match[1] === plainScopeReference) continue
			}
			for (
				let newline = content.indexOf('\n', scanned);
				newline !== -1 && newline < match.index;
				newline = content.indexOf('\n', newline + 1)
			) {
				line += 1
				scanned = newline + 1
			}
			if (line === lastReportedLine) continue
			lastReportedLine = line
			results.push({
				file,
				line,
				snippet: leftoverSnippet(content, match.index, match[0].length),
			})
			if (results.length >= maxLeftoverOriginReferences) return results
		}
	}
	return results
}

/** Snapshot strings that persist as raw bytes, not UTF-8 text. */
function isByteSnapshotFile(path: string, content: string) {
	return content.includes('\0') || shouldStoreArtifactBlobAsLatin1(path)
}

export function rewriteForkedPackageSelfReferences(input: {
	files: Record<string, string>
	originPackageName: string
	nextPackageName: string
	/** From `rewritePackageManifestForFork`: emit calls, subscriptions, docs. */
	topicRenames?: Record<string, string>
}): Record<string, string> {
	const textFiles: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.files)) {
		if (!isByteSnapshotFile(path, content)) textFiles[path] = content
	}
	const files = rewriteScopedReferences({
		files: textFiles,
		origin: input.originPackageName,
		next: input.nextPackageName,
		end: 'name',
	})
	for (const [path, content] of Object.entries(files)) {
		files[path] = rewriteEmittedTopicReferences(
			content,
			input.topicRenames ?? {},
		)
	}
	return { ...input.files, ...files }
}

/**
 * Files whose contents changed during fork rewrite (typically `package.json`
 * plus any self-references). The storage-layer copy already has the origin
 * tree; only these paths should be written back.
 */
export function collectChangedForkFiles(input: {
	originFiles: Record<string, string>
	rewrittenFiles: Record<string, string>
}): Record<string, string> {
	const changed: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.rewrittenFiles)) {
		if (input.originFiles[path] !== content) {
			changed[path] = content
		}
	}
	return changed
}
