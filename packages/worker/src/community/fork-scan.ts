import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'
import type { CrossScopeReference } from './types.ts'

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
 * Map each `kody.emits` topic the origin declares to the fork's topic. A
 * topic named after the origin package (`@kody/github.issue.opened`) takes
 * the fork's scope and leaf (`@jane/my-github.issue.opened`); any other
 * topic body keeps its body and only takes the fork's scope. Unchanged
 * topics are left out.
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
	return renames
}

/**
 * The topic body is lower-dot-case, so a reference ends where the next
 * character cannot continue it (a sentence-ending `.` still ends it).
 */
const emittedTopicReferenceEnd = '(?![a-z0-9_-]|\\.[a-z0-9*])'

function rewriteEmittedTopicReferences(
	content: string,
	topicRenames: Record<string, string>,
) {
	let next = content
	for (const [origin, target] of Object.entries(topicRenames)) {
		if (!next.includes(origin)) continue
		const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		next = next.replace(
			new RegExp(`${escaped}${emittedTopicReferenceEnd}`, 'g'),
			target,
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
		([origin, target]) =>
			origin.startsWith(ownPrefix) && target.startsWith(`${targetName}.`),
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
	 * Origin `kody.emits` topic → fork topic. Emits topics must use the
	 * package scope, so a fork renames them with the package; apply these to
	 * every other file with `rewriteForkedPackageSelfReferences`.
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

const scopedReferenceEnds = {
	/** A whole `@scope/name`: then a subpath, quote, space, comma, or end. */
	name: `(?=/|["'\`\\s,]|$)`,
	/** A bare `@scope` only where a package name follows. */
	scope: '(?=/)',
} as const

/**
 * Replace `origin` (`@scope/name`, or `@scope` with `end: 'scope'`) with
 * `next` in every file, only where the reference ends at a name boundary, so
 * `@kody/alpha` never rewrites inside `@kody/alpha-beta`.
 */
export function rewriteScopedReferences(input: {
	files: Record<string, string>
	origin: string
	next: string
	end: keyof typeof scopedReferenceEnds
}): Record<string, string> {
	const origin = input.origin.trim()
	const next = input.next.trim()
	if (!origin || origin === next) {
		return { ...input.files }
	}
	const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`${escaped}${scopedReferenceEnds[input.end]}`, 'g')
	const files: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.files)) {
		files[path] = content.includes(origin)
			? content.replace(pattern, next)
			: content
	}
	return files
}

export function rewriteForkedPackageSelfReferences(input: {
	files: Record<string, string>
	originPackageName: string
	nextPackageName: string
	/** From `rewritePackageManifestForFork`: emit calls, subscriptions, docs. */
	topicRenames?: Record<string, string>
}): Record<string, string> {
	const files = rewriteScopedReferences({
		files: input.files,
		origin: input.originPackageName,
		next: input.nextPackageName,
		end: 'name',
	})
	const topicRenames = input.topicRenames ?? {}
	if (Object.keys(topicRenames).length === 0) return files
	for (const [path, content] of Object.entries(files)) {
		files[path] = rewriteEmittedTopicReferences(content, topicRenames)
	}
	return files
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
