import { rewriteScopedReferences } from '#worker/community/fork-scan.ts'
import type {
	PackageCodemod,
	PackageCodemodContext,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const ownerScopeFollowsRegistryCodemodId =
	'0011-owner-scope-follows-registry'

const scopePattern = /^(@[^/\s]+)\/[^/\s]+$/

function readScope(name: unknown) {
	if (typeof name !== 'string') return null
	return scopePattern.exec(name.trim())?.[1] ?? null
}

function readManifestScope(files: Record<string, string>) {
	const manifest = files['package.json']
	if (typeof manifest !== 'string') return null
	try {
		const parsed: unknown = JSON.parse(manifest)
		if (!parsed || typeof parsed !== 'object') return null
		return readScope((parsed as { name?: unknown }).name)
	} catch {
		return null
	}
}

/**
 * The old scope (from `package.json`) and the new one (from the registry
 * name) when they differ, or null when the package already matches its
 * owner or either name is not `@scope/name`.
 */
function resolveScopeChange(
	files: Record<string, string>,
	context: PackageCodemodContext,
) {
	const from = readManifestScope(files)
	const to = readScope(context.packageName)
	if (!from || !to || from === to) return null
	return { from, to }
}

function transformOwnerScope(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const change = resolveScopeChange(files, context)
	if (!change) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [],
		}
	}
	const nextFiles = rewriteScopedReferences({
		files,
		origin: change.from,
		next: change.to,
		end: 'scope',
	})
	const changedPaths = Object.keys(files)
		.filter((path) => nextFiles[path] !== files[path])
		.sort((left, right) => left.localeCompare(right))
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual: [],
	}
}

function detectOwnerScope(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const change = resolveScopeChange(files, context)
	if (!change) return []
	const message = `References the previous owner scope ${change.from}/; rewrite to ${change.to}/ to match the registry name ${context.packageName}.`
	return transformOwnerScope(files, context).changedPaths.map((path) => ({
		path,
		message,
	}))
}

/**
 * After an org resource transfer the engine names each package in the new
 * owner's scope, but package sources still say `@oldScope/...` in
 * `package.json`, `kody:@oldScope/...` imports, and docs. Every package in
 * the old scope moved together, so every `@oldScope/` reference is
 * rewritten to `@newScope/`.
 */
export const ownerScopeFollowsRegistryCodemod: PackageCodemod = {
	id: ownerScopeFollowsRegistryCodemodId,
	description:
		'Rewrite @<oldScope>/ references to the owning org scope when package.json still names a previous owner (after an org resource transfer).',
	detect: detectOwnerScope,
	transform: transformOwnerScope,
}
