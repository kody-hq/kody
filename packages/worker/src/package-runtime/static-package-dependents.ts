import {
	countStaticDependentBundleArtifactPackages,
	listStaticDependentBundleArtifactRows,
	type StaticDependentBundleArtifactRow,
} from '#worker/repo/published-bundle-artifacts-repo.ts'

export const defaultStaticDependentPackageLimit = 10
export const defaultStaticDependentArtifactsPerPackageLimit = 5

/**
 * One saved package whose published bundle artifacts statically captured another
 * saved package through a `kody:@scope/package` import.
 */
export type StaticDependentPackageSummaryItem = {
	package_id: string
	kody_id: string
	name: string
	source_id: string
	published_commit: string | null
	stale: boolean
	artifact_count: number
	entrypoints: Array<string>
	entrypoints_truncated: boolean
	bundled_dependency_commit: string | null
	current_dependency_commit: string
	recommended_action: string
}

/**
 * Bounded publish-result summary of direct static dependents. Kody exposes this
 * so agents can decide whether to inspect and republish dependent packages; it
 * deliberately does not fan out or republish anything automatically.
 */
export type StaticPackageDependentsSummary = {
	total: number
	stale: number
	truncated: boolean
	items: Array<StaticDependentPackageSummaryItem>
	recommended_next_action: string
}

type BuildStaticPackageDependentsSummaryInput = {
	total: number
	stale: number
	rows: Array<StaticDependentBundleArtifactRow>
	currentDependencyCommit: string
	packageLimit?: number
	artifactsPerPackageLimit?: number
}

type StaticDependentPackageAccumulator = {
	package_id: string
	kody_id: string
	name: string
	source_id: string
	published_commit: string | null
	packageStale: boolean
	matchingArtifactCount: number
	matchingEntrypointCount: number
	artifactRows: Array<StaticDependentBundleArtifactRow>
	entrypoints: Array<string>
	packageBundledDependencyCommit: string | null
}

function createRecommendedNextAction(input: { total: number; stale: number }) {
	if (input.total === 0) {
		return 'No published bundle artifacts declare a static dependency on this package.'
	}
	if (input.stale === 0) {
		return 'Static dependents already reference the current published dependency commit; dependent republish is not indicated by bundle metadata.'
	}
	return 'Inspect stale static dependents and republish only the packages whose bundled snapshot should include this package publish. Kody does not republish dependents automatically.'
}

function createRecommendedItemAction(input: { stale: boolean }) {
	if (!input.stale) {
		return 'No action indicated by bundle metadata; this dependent already references the current dependency commit.'
	}
	return 'Inspect this dependent package and republish it if its bundled static kody:@ snapshot should include the published dependency commit.'
}

function createAccumulator(
	row: StaticDependentBundleArtifactRow,
): StaticDependentPackageAccumulator {
	return {
		package_id: row.packageId,
		kody_id: row.packageKodyId,
		name: row.packageName,
		source_id: row.sourceId,
		published_commit: row.publishedCommit,
		packageStale: row.packageStale,
		matchingArtifactCount: row.matchingArtifactCount,
		matchingEntrypointCount: row.matchingEntrypointCount,
		artifactRows: [],
		entrypoints: [],
		packageBundledDependencyCommit: row.packageBundledDependencyCommit,
	}
}

function addRowToAccumulator(input: {
	accumulator: StaticDependentPackageAccumulator
	row: StaticDependentBundleArtifactRow
}) {
	input.accumulator.artifactRows.push(input.row)
	input.accumulator.matchingArtifactCount = Math.max(
		input.accumulator.matchingArtifactCount,
		input.row.matchingArtifactCount,
	)
	input.accumulator.matchingEntrypointCount = Math.max(
		input.accumulator.matchingEntrypointCount,
		input.row.matchingEntrypointCount,
	)
	if (!input.accumulator.entrypoints.includes(input.row.entryPoint)) {
		input.accumulator.entrypoints.push(input.row.entryPoint)
	}
	input.accumulator.packageStale =
		input.accumulator.packageStale || input.row.packageStale
	input.accumulator.packageBundledDependencyCommit =
		input.accumulator.packageBundledDependencyCommit ===
		input.row.packageBundledDependencyCommit
			? input.accumulator.packageBundledDependencyCommit
			: null
}

export function buildStaticPackageDependentsSummary(
	input: BuildStaticPackageDependentsSummaryInput,
): StaticPackageDependentsSummary {
	const packageLimit = input.packageLimit ?? defaultStaticDependentPackageLimit
	const artifactsPerPackageLimit =
		input.artifactsPerPackageLimit ??
		defaultStaticDependentArtifactsPerPackageLimit
	const packages = new Map<string, StaticDependentPackageAccumulator>()
	for (const row of input.rows) {
		const accumulator = packages.get(row.packageId) ?? createAccumulator(row)
		packages.set(row.packageId, accumulator)
		addRowToAccumulator({
			accumulator,
			row,
		})
	}
	const items = [...packages.values()].slice(0, packageLimit).map(
		(item) =>
			({
				package_id: item.package_id,
				kody_id: item.kody_id,
				name: item.name,
				source_id: item.source_id,
				published_commit: item.published_commit,
				stale: item.packageStale,
				artifact_count: item.matchingArtifactCount,
				entrypoints: item.entrypoints.slice(0, artifactsPerPackageLimit),
				entrypoints_truncated:
					item.matchingEntrypointCount >
					Math.min(item.entrypoints.length, artifactsPerPackageLimit),
				bundled_dependency_commit: item.packageBundledDependencyCommit,
				current_dependency_commit: input.currentDependencyCommit,
				recommended_action: createRecommendedItemAction({
					stale: item.packageStale,
				}),
			}) satisfies StaticDependentPackageSummaryItem,
	)
	return {
		total: input.total,
		stale: input.stale,
		truncated: input.total > items.length,
		items,
		recommended_next_action: createRecommendedNextAction({
			total: input.total,
			stale: input.stale,
		}),
	}
}

export async function getStaticPackageDependentsSummary(input: {
	db: D1Database
	userId: string
	sourceId: string
	currentDependencyCommit: string
	packageLimit?: number
	artifactsPerPackageLimit?: number
}): Promise<StaticPackageDependentsSummary> {
	const packageLimit = input.packageLimit ?? defaultStaticDependentPackageLimit
	const artifactsPerPackageLimit =
		input.artifactsPerPackageLimit ??
		defaultStaticDependentArtifactsPerPackageLimit
	const [counts, rows] = await Promise.all([
		countStaticDependentBundleArtifactPackages(input.db, {
			userId: input.userId,
			sourceId: input.sourceId,
			currentDependencyCommit: input.currentDependencyCommit,
		}),
		listStaticDependentBundleArtifactRows(input.db, {
			userId: input.userId,
			sourceId: input.sourceId,
			currentDependencyCommit: input.currentDependencyCommit,
			packageLimit,
			artifactsPerPackageLimit,
		}),
	])
	return buildStaticPackageDependentsSummary({
		total: counts.totalPackages,
		stale: counts.stalePackages,
		rows,
		currentDependencyCommit: input.currentDependencyCommit,
		packageLimit,
		artifactsPerPackageLimit,
	})
}
