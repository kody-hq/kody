import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'

/**
 * Detect cycles in static `kody:@` / `package.json#kody.dependencies` graphs.
 * Edges are package names (`@scope/leaf`). Missing nodes have no outgoing
 * edges (an unpublished or platform-live dependency cannot close a user-local
 * cycle). A saved package whose published manifest cannot load fails the
 * graph walk instead of pretending it has no dependencies; that failure is
 * Kody's (Artifacts / storage read), not the authored package's.
 */

export type LoadedStaticKodyDependencyEdges =
	| { ok: true; edges: Map<string, Array<string>> }
	| { ok: false; message: string; failureOrigin: 'platform' }
export function findStaticKodyDependencyCycle(input: {
	rootPackageName: string
	edges: ReadonlyMap<string, ReadonlyArray<string>>
}): Array<string> | null {
	const root = input.rootPackageName.trim()
	if (!root) return null
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const path: Array<string> = []

	function walk(packageName: string): Array<string> | null {
		if (visiting.has(packageName)) {
			const cycleStart = path.indexOf(packageName)
			if (cycleStart === -1) return null
			return [...path.slice(cycleStart), packageName]
		}
		if (visited.has(packageName)) return null
		visiting.add(packageName)
		path.push(packageName)
		for (const dependency of input.edges.get(packageName) ?? []) {
			const next = dependency.trim()
			if (!next) continue
			const cycle = walk(next)
			if (cycle) return cycle
		}
		path.pop()
		visiting.delete(packageName)
		visited.add(packageName)
		return null
	}

	return walk(root)
}

export function formatStaticKodyDependencyCycleMessage(
	cycle: ReadonlyArray<string>,
) {
	return `package.json#kody.dependencies forms a cycle: ${cycle.join(' -> ')}.`
}

export function formatStaticKodyDependencyLoadFailureMessage(input: {
	packageName: string
	cause: unknown
}) {
	return `Could not load the saved package manifest for ${input.packageName} while checking package.json#kody.dependencies: ${getErrorMessage(input.cause)}.`
}

export async function loadReachableStaticKodyDependencyEdges(input: {
	env: Env
	baseUrl: string
	userId: string
	rootPackageName: string
	rootDependencies: ReadonlyArray<string>
}): Promise<LoadedStaticKodyDependencyEdges> {
	const edges = new Map<string, Array<string>>()
	const rootDependencies = listKodyPackageDependencyNames(
		input.rootDependencies,
	)
	edges.set(input.rootPackageName, rootDependencies)
	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.userId,
	})
	const savedByName = new Map(
		savedPackages.map((savedPackage) => [savedPackage.name, savedPackage]),
	)
	const pending = [...rootDependencies]
	while (pending.length > 0) {
		const packageName = pending.pop()
		if (!packageName || edges.has(packageName)) continue
		const savedPackage = savedByName.get(packageName)
		if (!savedPackage) {
			edges.set(packageName, [])
			continue
		}
		try {
			const loaded = await loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})
			const dependencies = listKodyPackageDependencyNames(
				loaded.manifest.kody.dependencies,
			)
			edges.set(packageName, dependencies)
			pending.push(...dependencies)
		} catch (cause) {
			return {
				ok: false,
				failureOrigin: 'platform',
				message: formatStaticKodyDependencyLoadFailureMessage({
					packageName,
					cause,
				}),
			}
		}
	}
	return { ok: true, edges }
}
