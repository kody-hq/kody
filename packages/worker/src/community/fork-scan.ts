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

export function rewritePackageManifestForFork(input: {
	manifestContent: string
	expectedPackageScope: string
	targetKodyId: string
}): { content: string; targetName: string } {
	const parsed = JSON.parse(input.manifestContent) as Record<string, unknown>
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
	return {
		content: `${JSON.stringify(next, null, '\t')}\n`,
		targetName,
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
}): Record<string, string> {
	return rewriteScopedReferences({
		files: input.files,
		origin: input.originPackageName,
		next: input.nextPackageName,
		end: 'name',
	})
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
