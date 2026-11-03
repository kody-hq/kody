const packageManifestPath = 'package.json'

export const publishedRuntimeBundleMissingMessage =
	'no published runtime bundle artifact is available yet'

/** How long invoke may serve the previous npm bundle after published_commit flips. */
export const publishedNpmBundleRebuildWindowMs = 2 * 60 * 1000

export function isPublishedSourceWithinNpmBundleRebuildWindow(input: {
	publishedAt: string | null | undefined
	nowMs?: number
}) {
	const publishedAtMs = Date.parse(input.publishedAt ?? '')
	if (!Number.isFinite(publishedAtMs)) return false
	return (
		(input.nowMs ?? Date.now()) - publishedAtMs <=
		publishedNpmBundleRebuildWindowMs
	)
}

/**
 * Keep the previous npm runtime bundle when one exists and the publish
 * finalize clock is still inside the rebuild window — or is unknown.
 *
 * `snapshotCreatedAt` is null after `published_commit` flips and before
 * `writePublishedSourceSnapshot`, and on Artifacts backfill (backfill is
 * not a publish clock). A missing clock is not "outside the window".
 * Brand-new exports with no previous artifact still 503 until rebuild.
 */
export function canKeepPreviousNpmBundleDuringRebuild(input: {
	publishedAt: string | null | undefined
	nowMs?: number
}) {
	if (!input.publishedAt) return true
	return isPublishedSourceWithinNpmBundleRebuildWindow(input)
}

function getDeclaredPackageDependencies(sourceFiles: Record<string, string>) {
	const packageJson = sourceFiles[packageManifestPath]
	if (!packageJson) return []
	try {
		const parsed = JSON.parse(packageJson) as {
			dependencies?: Record<string, string>
		}
		return Object.keys(parsed.dependencies ?? {}).sort((left, right) =>
			left.localeCompare(right),
		)
	} catch {
		return []
	}
}

function getMissingInstalledDependencies(input: {
	sourceFiles: Record<string, string>
	dependencies: Array<string>
}) {
	return input.dependencies.filter(
		(dependencyName) =>
			input.sourceFiles[`node_modules/${dependencyName}/package.json`] == null,
	)
}

export function listMissingPublishedSourceInstalledDependencies(
	sourceFiles: Record<string, string>,
) {
	const dependencies = getDeclaredPackageDependencies(sourceFiles)
	if (dependencies.length === 0) return []
	return getMissingInstalledDependencies({
		sourceFiles,
		dependencies,
	})
}

export function isPublishedRuntimeBundleMissingError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.includes(publishedRuntimeBundleMissingMessage)
	)
}

export function createPublishedRuntimeBundleMissingError(input: {
	missingDependencies: ReadonlyArray<string>
	bundleLabel: string
}) {
	return new Error(
		`${input.bundleLabel} declares npm dependencies (${input.missingDependencies
			.map((dependency) => `"${dependency}"`)
			.join(
				', ',
			)}) but ${publishedRuntimeBundleMissingMessage}. Republish the package so Kody can install dependencies and persist a fresh runtime bundle artifact.`,
	)
}

export function assertPublishedSourceCanRebuildWithoutInstallingDeps(input: {
	sourceFiles: Record<string, string>
	bundleLabel: string
}) {
	const missingDependencies = listMissingPublishedSourceInstalledDependencies(
		input.sourceFiles,
	)
	if (missingDependencies.length === 0) return
	throw createPublishedRuntimeBundleMissingError({
		missingDependencies,
		bundleLabel: input.bundleLabel,
	})
}
