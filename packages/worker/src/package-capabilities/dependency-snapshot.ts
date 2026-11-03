import type { BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'

/**
 * Lockfile-like pin recorded with an internet-visible capability approval.
 * Reuses published bundle dependency fields so serving/retention (PR3) can
 * match without a parallel schema. Regular packages keep floating; only
 * internet-visible approvals persist this snapshot.
 */
export type PackageDependencySnapshot = {
	version: 1
	root: {
		packageId: string
		kodyId: string
		sourceId: string
		publishedCommit: string
	}
	dependencies: Array<BundleArtifactDependency>
}

export function emptyDependencySnapshot(root: {
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string
}): PackageDependencySnapshot {
	return {
		version: 1,
		root: {
			packageId: root.packageId,
			kodyId: root.kodyId,
			sourceId: root.sourceId,
			publishedCommit: root.publishedCommit,
		},
		dependencies: [],
	}
}

export function canonicalizeDependencySnapshot(
	snapshot: PackageDependencySnapshot,
): PackageDependencySnapshot {
	const dependencies = [...snapshot.dependencies]
		.filter(
			(dependency) =>
				Boolean(dependency.sourceId) &&
				Boolean(dependency.publishedCommit) &&
				Boolean(dependency.kodyId),
		)
		.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.sourceId.localeCompare(right.sourceId),
		)
	return {
		version: 1,
		root: { ...snapshot.root },
		dependencies,
	}
}

export function serializeDependencySnapshot(
	snapshot: PackageDependencySnapshot,
): string {
	return JSON.stringify(canonicalizeDependencySnapshot(snapshot))
}

export function parseDependencySnapshotJson(
	raw: string | null | undefined,
): PackageDependencySnapshot | null {
	if (!raw || raw.trim() === '' || raw.trim() === '{}') return null
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object') return null
		const record = parsed as Record<string, unknown>
		if (record.version !== 1) return null
		const root = record.root
		if (!root || typeof root !== 'object') return null
		const rootRecord = root as Record<string, unknown>
		const packageId = String(rootRecord.packageId ?? '')
		const kodyId = String(rootRecord.kodyId ?? '')
		const sourceId = String(rootRecord.sourceId ?? '')
		const publishedCommit = String(rootRecord.publishedCommit ?? '')
		if (!packageId || !kodyId || !sourceId || !publishedCommit) return null
		const dependenciesRaw = Array.isArray(record.dependencies)
			? record.dependencies
			: []
		const dependencies: Array<BundleArtifactDependency> = []
		for (const entry of dependenciesRaw) {
			if (!entry || typeof entry !== 'object') continue
			const dep = entry as Record<string, unknown>
			const depSourceId = String(dep.sourceId ?? '')
			const depPublishedCommit = String(dep.publishedCommit ?? '')
			const depKodyId = String(dep.kodyId ?? '')
			if (!depSourceId || !depPublishedCommit || !depKodyId) continue
			const dependency: BundleArtifactDependency = {
				sourceId: depSourceId,
				publishedCommit: depPublishedCommit,
				kodyId: depKodyId,
			}
			if (typeof dep.packageName === 'string' && dep.packageName.trim()) {
				dependency.packageName = dep.packageName
			}
			if (typeof dep.packageId === 'string' && dep.packageId.trim()) {
				dependency.packageId = dep.packageId
			}
			if (dep.transitive === true) {
				dependency.transitive = true
			}
			dependencies.push(dependency)
		}
		return canonicalizeDependencySnapshot({
			version: 1,
			root: { packageId, kodyId, sourceId, publishedCommit },
			dependencies,
		})
	} catch {
		return null
	}
}
