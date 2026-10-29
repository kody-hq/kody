import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import {
	loadPackageManifestForSource,
	loadPackageSourceRowForUser,
} from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from './package-artifact-targets.ts'
import {
	isPublishedPackageArtifactBuiltForCommit,
	loadPublishedBundleArtifactsForPackageTargets,
	publishedBundleArtifactForPackageTarget,
	type LoadedPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { hasPublishedRuntimeArtifacts } from './published-runtime-artifacts.ts'

/** Keyset page size when walking `saved_packages` for gap detection. */
export const publishedImportableArtifactBackfillScanPageSize = 50

/**
 * Soft per-step budget for apply. Rebuilds are DO/esbuild-heavy; keep one
 * execute/sandbox invocation to a handful of packages and resume via cursor.
 */
export const publishedImportableArtifactBackfillApplyLimitDefault = 5
export const publishedImportableArtifactBackfillApplyLimitMax = 10
export const publishedImportableArtifactBackfillScanLimitDefault = 50
export const publishedImportableArtifactBackfillScanLimitMax = 200

export type PublishedImportableArtifactBackfillOutcome =
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string
			missingImportableCount: number
			outcome: 'would_rebuild' | 'rebuilt' | 'already_built'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: null
			missingImportableCount: number
			outcome: 'skipped_unpublished'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string | null
			missingImportableCount: number
			outcome: 'failed'
			error: string
	  }

export type PublishedImportableArtifactBackfillResult = {
	dryRun: boolean
	scannedPackages: number
	publishedPackages: number
	packagesNeedingRebuild: number
	missingImportableArtifacts: number
	/**
	 * Packages in this page with at least one missing subpath (non-root)
	 * importable-module artifact. Subset of `packagesNeedingRebuild`.
	 */
	packagesMissingSubpathImportable: number
	rebuiltPackages: number
	failedPackages: number
	alreadyBuiltPackages: number
	skippedUnpublished: number
	nextCursor: string | null
	outcomes: Array<PublishedImportableArtifactBackfillOutcome>
}

function isSubpathImportableTarget(
	target: PublishedPackageArtifactBuildTarget,
) {
	return target.artifactName != null && target.artifactName !== '.'
}

function importableTargets(
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>,
) {
	return targets.filter((target) => target.kind === 'importable-module')
}

async function findMissingImportableTargets(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	publishedCommit: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
}): Promise<Array<PublishedPackageArtifactBuildTarget>> {
	const candidates = importableTargets(input.targets)
	const missing: Array<PublishedPackageArtifactBuildTarget> = []
	if (candidates.length === 0) return missing
	// Without BUNDLE_ARTIFACTS_KV, identity preload hydrates D1 rows via KV and
	// throws. Match the built-for-commit guard: treat every candidate as missing
	// so the scan completes without marking the package failed.
	const loadedByIdentity = hasPublishedRuntimeArtifacts(input.env)
		? await loadPublishedBundleArtifactsForPackageTargets({
				env: input.env,
				userId: input.userId,
				sourceId: input.sourceId,
				targets: candidates,
			})
		: new Map<string, LoadedPublishedBundleArtifact | null>()
	for (const target of candidates) {
		const built = await isPublishedPackageArtifactBuiltForCommit({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
			preloaded: publishedBundleArtifactForPackageTarget({
				sourceId: input.sourceId,
				target,
				loadedByIdentity,
			}),
		})
		if (!built) missing.push(target)
	}
	return missing
}

function matchesOptionalFilters(
	savedPackage: SavedPackageRecord,
	filters: {
		packageIds?: ReadonlySet<string>
		ownerUserIds?: ReadonlySet<string>
	},
) {
	if (filters.packageIds && !filters.packageIds.has(savedPackage.id)) {
		return false
	}
	if (filters.ownerUserIds && !filters.ownerUserIds.has(savedPackage.userId)) {
		return false
	}
	return true
}

export async function listCandidatePackages(input: {
	env: Env
	afterId: string | null
	limit: number
	packageIds?: ReadonlySet<string>
	ownerUserIds?: ReadonlySet<string>
}): Promise<{
	packages: Array<SavedPackageRecord>
	nextCursor: string | null
}> {
	const packages: Array<SavedPackageRecord> = []
	let cursor = input.afterId
	let pagesScanned = 0
	const maxPages = 20
	for (;;) {
		pagesScanned += 1
		const page = await listSavedPackagesPage(input.env.APP_DB, {
			afterId: cursor,
			limit: publishedImportableArtifactBackfillScanPageSize,
		})
		if (page.length === 0) {
			return { packages, nextCursor: null }
		}
		for (const savedPackage of page) {
			cursor = savedPackage.id
			if (!matchesOptionalFilters(savedPackage, input)) continue
			packages.push(savedPackage)
			if (packages.length >= input.limit) {
				return { packages, nextCursor: savedPackage.id }
			}
		}
		if (page.length < publishedImportableArtifactBackfillScanPageSize) {
			return { packages, nextCursor: null }
		}
		if (pagesScanned >= maxPages) {
			return { packages, nextCursor: cursor }
		}
	}
}

/**
 * Fleet scan/apply for published packages whose importable-module artifacts
 * are missing or stale at the current published commit. dryRun (default)
 * reports gaps only; apply rebuilds at that commit with no content change.
 * Idempotent: already-built targets are skipped inside the rebuild helper.
 */
export async function runPublishedImportableArtifactBackfill(input: {
	env: Env
	baseUrl: string
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	packageIds?: ReadonlyArray<string>
	ownerUserIds?: ReadonlyArray<string>
}): Promise<PublishedImportableArtifactBackfillResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.max(
		1,
		Math.min(
			input.limit ??
				(dryRun
					? publishedImportableArtifactBackfillScanLimitDefault
					: publishedImportableArtifactBackfillApplyLimitDefault),
			dryRun
				? publishedImportableArtifactBackfillScanLimitMax
				: publishedImportableArtifactBackfillApplyLimitMax,
		),
	)
	const packageIds = input.packageIds?.length
		? new Set(input.packageIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const ownerUserIds = input.ownerUserIds?.length
		? new Set(input.ownerUserIds.map((id) => id.trim()).filter(Boolean))
		: undefined

	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds,
		ownerUserIds,
	})

	const outcomes: Array<PublishedImportableArtifactBackfillOutcome> = []
	let publishedPackages = 0
	let packagesNeedingRebuild = 0
	let missingImportableArtifacts = 0
	let packagesMissingSubpathImportable = 0
	let rebuiltPackages = 0
	let failedPackages = 0
	let alreadyBuiltPackages = 0
	let skippedUnpublished = 0

	for (const savedPackage of packages) {
		let publishedCommit: string | null = null
		let missingCount = 0
		try {
			// Read the source row first: loadPackageManifestBySourceId throws on
			// unpublished packages before a null published_commit check can run.
			const source = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			publishedCommit = source.published_commit?.trim() || null
			if (!publishedCommit) {
				skippedUnpublished += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit: null,
					missingImportableCount: 0,
					outcome: 'skipped_unpublished',
				})
				continue
			}
			const loaded = await loadPackageManifestForSource({
				env: input.env,
				userId: savedPackage.userId,
				source,
			})
			publishedPackages += 1
			const targets = collectPublishedPackageArtifactTargets(loaded.manifest)
			const missing = await findMissingImportableTargets({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				targets,
			})
			missingCount = missing.length
			if (missing.length === 0) {
				alreadyBuiltPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					missingImportableCount: 0,
					outcome: 'already_built',
				})
				continue
			}
			packagesNeedingRebuild += 1
			missingImportableArtifacts += missing.length
			if (missing.some(isSubpathImportableTarget)) {
				packagesMissingSubpathImportable += 1
			}
			if (dryRun) {
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					missingImportableCount: missing.length,
					outcome: 'would_rebuild',
				})
				continue
			}
			// Re-check before rebuild so a concurrent publish cannot label new
			// source under the scanned commit.
			const freshSource = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			const freshCommit = freshSource.published_commit?.trim() || null
			if (freshCommit !== publishedCommit) {
				throw new Error(
					`Published commit changed from "${publishedCommit}" to "${freshCommit ?? 'unpublished'}" during importable artifact backfill; retry this package.`,
				)
			}
			await rebuildPublishedPackageArtifactsViaRepoSession({
				env: input.env,
				rpcSessionId: `artifact-backfill-${savedPackage.sourceId}`,
				sourceId: savedPackage.sourceId,
				userId: savedPackage.userId,
				publishedCommit,
				baseUrl: input.baseUrl,
				targets: missing,
			})
			rebuiltPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				missingImportableCount: missing.length,
				outcome: 'rebuilt',
			})
		} catch (error) {
			failedPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				missingImportableCount: missingCount,
				outcome: 'failed',
				error: getErrorMessage(error),
			})
		}
	}

	return {
		dryRun,
		scannedPackages: packages.length,
		publishedPackages,
		packagesNeedingRebuild,
		missingImportableArtifacts,
		packagesMissingSubpathImportable,
		rebuiltPackages,
		failedPackages,
		alreadyBuiltPackages,
		skippedUnpublished,
		nextCursor,
		outcomes,
	}
}
