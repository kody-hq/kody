import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import { loadPackageSourceRowForUser } from '#worker/package-registry/source.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { readArtifactTreeAtCommit } from '#worker/repo/artifact-file.ts'
import {
	readPublishedSourceSnapshot,
	writePublishedSourceSnapshot,
} from './published-runtime-artifacts.ts'

/** Keyset page size when walking `saved_packages` for gap detection. */
export const publishedSourceSnapshotBackfillScanPageSize = 50

/**
 * Soft per-step budget for apply. Git tree reads are heavier than a KV get;
 * keep one execute/sandbox invocation to a handful of repairs and resume via
 * cursor.
 */
export const publishedSourceSnapshotBackfillApplyLimitDefault = 5
export const publishedSourceSnapshotBackfillApplyLimitMax = 10
export const publishedSourceSnapshotBackfillScanLimitDefault = 50
export const publishedSourceSnapshotBackfillScanLimitMax = 200

export type PublishedSourceSnapshotBackfillOutcome =
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string
			outcome: 'would_rebuild' | 'rebuilt' | 'already_present'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: null
			outcome: 'skipped_unpublished'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string | null
			outcome: 'failed'
			error: string
	  }

export type PublishedSourceSnapshotBackfillResult = {
	dryRun: boolean
	scannedPackages: number
	publishedPackages: number
	packagesNeedingRebuild: number
	rebuiltPackages: number
	failedPackages: number
	alreadyPresentPackages: number
	skippedUnpublished: number
	nextCursor: string | null
	outcomes: Array<PublishedSourceSnapshotBackfillOutcome>
}

function matchesOptionalFilters(
	savedPackage: SavedPackageRecord,
	filters: {
		packageIds?: ReadonlySet<string>
		ownerUserIds?: ReadonlySet<string>
		sourceIds?: ReadonlySet<string>
	},
) {
	if (filters.packageIds && !filters.packageIds.has(savedPackage.id)) {
		return false
	}
	if (filters.ownerUserIds && !filters.ownerUserIds.has(savedPackage.userId)) {
		return false
	}
	if (filters.sourceIds && !filters.sourceIds.has(savedPackage.sourceId)) {
		return false
	}
	return true
}

async function listCandidatePackages(input: {
	env: Env
	afterId: string | null
	limit: number
	packageIds?: ReadonlySet<string>
	ownerUserIds?: ReadonlySet<string>
	sourceIds?: ReadonlySet<string>
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
			limit: publishedSourceSnapshotBackfillScanPageSize,
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
		if (page.length < publishedSourceSnapshotBackfillScanPageSize) {
			return { packages, nextCursor: null }
		}
		if (pagesScanned >= maxPages) {
			return { packages, nextCursor: cursor }
		}
	}
}

/**
 * Rebuild the published source + manifest KV snapshots for one package from
 * the Artifacts git tree at its current published_commit. Idempotent when the
 * snapshot is already present.
 */
export async function rebuildPublishedSourceSnapshotFromArtifacts(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	publishedCommit: string
}): Promise<'rebuilt' | 'already_present'> {
	const source = await loadPackageSourceRowForUser({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	const publishedCommit = source.published_commit?.trim() || null
	if (publishedCommit !== input.publishedCommit) {
		throw new Error(
			`Published commit changed from "${input.publishedCommit}" to "${publishedCommit ?? 'unpublished'}" during source snapshot backfill; retry this package.`,
		)
	}
	const existing = await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: source.id,
		publishedCommit,
	})
	if (existing?.files && Object.keys(existing.files).length > 0) {
		return 'already_present'
	}
	const files = await readArtifactTreeAtCommit({
		env: input.env,
		repoId: source.repo_id,
		commit: publishedCommit,
	})
	if (!files || Object.keys(files).length === 0) {
		throw new Error(
			`Artifact tree for source "${source.id}" at commit "${publishedCommit}" was empty or missing.`,
		)
	}
	await writePublishedSourceSnapshot({
		env: input.env,
		source: {
			...source,
			published_commit: publishedCommit,
		},
		files,
		recoveredFromArtifacts: true,
	})
	return 'rebuilt'
}

/**
 * Fleet scan/apply for published packages whose source-snapshot KV key is
 * missing at the current published commit. dryRun (default) reports gaps
 * only; apply rebuilds from the Artifacts git tip with no content change.
 */
export async function runPublishedSourceSnapshotBackfill(input: {
	env: Env
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	packageIds?: ReadonlyArray<string>
	ownerUserIds?: ReadonlyArray<string>
	sourceIds?: ReadonlyArray<string>
}): Promise<PublishedSourceSnapshotBackfillResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.max(
		1,
		Math.min(
			input.limit ??
				(dryRun
					? publishedSourceSnapshotBackfillScanLimitDefault
					: publishedSourceSnapshotBackfillApplyLimitDefault),
			dryRun
				? publishedSourceSnapshotBackfillScanLimitMax
				: publishedSourceSnapshotBackfillApplyLimitMax,
		),
	)
	const packageIds = input.packageIds?.length
		? new Set(input.packageIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const ownerUserIds = input.ownerUserIds?.length
		? new Set(input.ownerUserIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const sourceIds = input.sourceIds?.length
		? new Set(input.sourceIds.map((id) => id.trim()).filter(Boolean))
		: undefined

	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds,
		ownerUserIds,
		sourceIds,
	})

	const outcomes: Array<PublishedSourceSnapshotBackfillOutcome> = []
	let publishedPackages = 0
	let packagesNeedingRebuild = 0
	let rebuiltPackages = 0
	let failedPackages = 0
	let alreadyPresentPackages = 0
	let skippedUnpublished = 0

	for (const savedPackage of packages) {
		let publishedCommit: string | null = null
		try {
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
					outcome: 'skipped_unpublished',
				})
				continue
			}
			publishedPackages += 1
			const existing = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: source.id,
				publishedCommit,
			})
			if (existing?.files && Object.keys(existing.files).length > 0) {
				alreadyPresentPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					outcome: 'already_present',
				})
				continue
			}
			packagesNeedingRebuild += 1
			if (dryRun) {
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					outcome: 'would_rebuild',
				})
				continue
			}
			const result = await rebuildPublishedSourceSnapshotFromArtifacts({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
			})
			if (result === 'already_present') {
				alreadyPresentPackages += 1
				packagesNeedingRebuild -= 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					outcome: 'already_present',
				})
				continue
			}
			rebuiltPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
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
		rebuiltPackages,
		failedPackages,
		alreadyPresentPackages,
		skippedUnpublished,
		nextCursor,
		outcomes,
	}
}
