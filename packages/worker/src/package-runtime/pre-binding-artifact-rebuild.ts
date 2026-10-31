/**
 * Fleet rebuild for published bundles built before package `fetch` and `kody`
 * became lexically bound (GHSA-5fv3). Load sites repair single-package bundles
 * in memory and refuse mixed bundles only when source can rebuild without npm,
 * so a mixed bundle that needs npm keeps serving its pre-binding code. In that
 * bundle a wrapper package's credential use is attributed to the caller.
 *
 * dryRun (default) reports stale targets only. Apply force-rebuilds those
 * targets at the current published commit: no source, version, visibility,
 * enablement, job, or hostname change.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import {
	loadPackageManifestForSource,
	loadPackageSourceRowForUser,
} from '#worker/package-registry/source.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from './package-artifact-targets.ts'
import {
	loadPublishedBundleArtifactsForPackageTargets,
	publishedBundleArtifactForPackageTarget,
} from './published-bundle-artifacts.ts'
import { listCandidatePackages } from './published-importable-artifact-backfill.ts'
import { hasPublishedRuntimeArtifacts } from './published-runtime-artifacts.ts'
import {
	isPreBindingPublishedArtifact,
	isRepairableArtifactKind,
	isUnrepairablePreBindingArtifact,
	publishedArtifactInlinesOtherPackages,
} from './pre-binding-artifact-repair.ts'

export const preBindingArtifactRebuildApplyLimitDefault = 5
export const preBindingArtifactRebuildApplyLimitMax = 10
export const preBindingArtifactRebuildScanLimitDefault = 50
export const preBindingArtifactRebuildScanLimitMax = 200

export type PreBindingArtifactRebuildOutcome = {
	packageId: string
	ownerUserId: OwnerId
	sourceId: string
	publishedCommit: string | null
	staleTargets: number
	staleMultiPackageTargets: number
	/** Stored targets built from another commit than the published one. */
	otherCommitTargets?: number
	outcome:
		| 'would_rebuild'
		| 'rebuilt'
		| 'current'
		| 'other_commit_artifacts'
		| 'skipped_unpublished'
		| 'skipped_no_artifacts'
		| 'failed'
	error?: string
}

export type PreBindingArtifactRebuildResult = {
	dryRun: boolean
	scannedPackages: number
	publishedPackages: number
	packagesNeedingRebuild: number
	staleTargets: number
	staleMultiPackageTargets: number
	rebuiltPackages: number
	stillStaleAfterRebuild: number
	failedPackages: number
	currentPackages: number
	/** No pre-binding target, but a stored target is from another commit. */
	otherCommitPackages: number
	skippedUnpublished: number
	skippedNoArtifacts: number
	nextCursor: string | null
	outcomes: Array<PreBindingArtifactRebuildOutcome>
}

/** True when the stored bundle still runs pre-binding package code. */
export function isStalePreBindingArtifact(artifact: {
	kind?: string
	modules: Parameters<typeof isPreBindingPublishedArtifact>[0]['modules']
	dependencies: Array<{ packageId?: string }>
	packageContext: { packageId: string } | null
	packageBindingRewrite?: number
}) {
	if (!isRepairableArtifactKind(artifact.kind)) return false
	return (
		isPreBindingPublishedArtifact(artifact) ||
		isUnrepairablePreBindingArtifact(artifact)
	)
}

async function findStaleTargets(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	publishedCommit: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
}) {
	const candidates = input.targets.filter((target) =>
		isRepairableArtifactKind(target.kind),
	)
	const stale: Array<PublishedPackageArtifactBuildTarget> = []
	/** No stored artifact, or one built from another published commit. */
	const notCurrent: Array<PublishedPackageArtifactBuildTarget> = []
	let multiPackage = 0
	let stored = 0
	let otherCommit = 0
	if (candidates.length === 0) {
		return { stale, notCurrent, multiPackage, stored, otherCommit }
	}
	const loadedByIdentity = await loadPublishedBundleArtifactsForPackageTargets({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		targets: candidates,
	})
	for (const target of candidates) {
		const loaded = publishedBundleArtifactForPackageTarget({
			sourceId: input.sourceId,
			target,
			loadedByIdentity,
		})
		const artifact = loaded?.artifact
		if (!artifact) {
			notCurrent.push(target)
			continue
		}
		stored += 1
		if (artifact.publishedCommit !== input.publishedCommit) {
			notCurrent.push(target)
			otherCommit += 1
			continue
		}
		if (!isStalePreBindingArtifact(artifact)) continue
		stale.push(target)
		if (publishedArtifactInlinesOtherPackages(artifact)) multiPackage += 1
	}
	return { stale, notCurrent, multiPackage, stored, otherCommit }
}

export async function runPreBindingArtifactRebuild(input: {
	env: Env
	baseUrl: string
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	packageIds?: ReadonlyArray<string>
	ownerUserIds?: ReadonlyArray<string>
}): Promise<PreBindingArtifactRebuildResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.max(
		1,
		Math.min(
			input.limit ??
				(dryRun
					? preBindingArtifactRebuildScanLimitDefault
					: preBindingArtifactRebuildApplyLimitDefault),
			dryRun
				? preBindingArtifactRebuildScanLimitMax
				: preBindingArtifactRebuildApplyLimitMax,
		),
	)
	const toSet = (values?: ReadonlyArray<string>) =>
		values?.length
			? new Set(values.map((value) => value.trim()).filter(Boolean))
			: undefined
	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds: toSet(input.packageIds),
		ownerUserIds: toSet(input.ownerUserIds),
	})
	const result: PreBindingArtifactRebuildResult = {
		dryRun,
		scannedPackages: packages.length,
		publishedPackages: 0,
		packagesNeedingRebuild: 0,
		staleTargets: 0,
		staleMultiPackageTargets: 0,
		rebuiltPackages: 0,
		stillStaleAfterRebuild: 0,
		failedPackages: 0,
		currentPackages: 0,
		otherCommitPackages: 0,
		skippedUnpublished: 0,
		skippedNoArtifacts: 0,
		nextCursor,
		outcomes: [],
	}
	if (!hasPublishedRuntimeArtifacts(input.env)) {
		throw new Error('Published runtime artifacts are not configured.')
	}
	for (const savedPackage of packages) {
		const base = {
			packageId: savedPackage.id,
			ownerUserId: savedPackage.userId,
			sourceId: savedPackage.sourceId,
		}
		let publishedCommit: string | null = null
		let staleCount = 0
		let multiCount = 0
		try {
			const source = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			publishedCommit = source.published_commit?.trim() || null
			if (!publishedCommit) {
				result.skippedUnpublished += 1
				result.outcomes.push({
					...base,
					publishedCommit,
					staleTargets: 0,
					staleMultiPackageTargets: 0,
					outcome: 'skipped_unpublished',
				})
				continue
			}
			result.publishedPackages += 1
			const { manifest } = await loadPackageManifestForSource({
				env: input.env,
				userId: savedPackage.userId,
				source,
			})
			const targets = collectPublishedPackageArtifactTargets(manifest)
			const scan = await findStaleTargets({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				targets,
			})
			staleCount = scan.stale.length
			multiCount = scan.multiPackage
			if (scan.stored === 0) {
				result.skippedNoArtifacts += 1
				result.outcomes.push({
					...base,
					publishedCommit,
					staleTargets: 0,
					staleMultiPackageTargets: 0,
					outcome: 'skipped_no_artifacts',
				})
				continue
			}
			if (staleCount === 0 && scan.otherCommit > 0) {
				// Not pre-binding, but not current for the published commit either:
				// report the gap instead of calling the package current.
				result.otherCommitPackages += 1
				result.outcomes.push({
					...base,
					publishedCommit,
					staleTargets: 0,
					staleMultiPackageTargets: 0,
					otherCommitTargets: scan.otherCommit,
					outcome: 'other_commit_artifacts',
				})
				continue
			}
			if (staleCount === 0) {
				result.currentPackages += 1
				result.outcomes.push({
					...base,
					publishedCommit,
					staleTargets: 0,
					staleMultiPackageTargets: 0,
					outcome: 'current',
				})
				continue
			}
			result.packagesNeedingRebuild += 1
			result.staleTargets += staleCount
			result.staleMultiPackageTargets += multiCount
			if (dryRun) {
				result.outcomes.push({
					...base,
					publishedCommit,
					staleTargets: staleCount,
					staleMultiPackageTargets: multiCount,
					outcome: 'would_rebuild',
				})
				continue
			}
			const fresh = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			const freshCommit = fresh.published_commit?.trim() || null
			if (freshCommit !== publishedCommit) {
				throw new Error(
					'Published commit changed during the pre-binding rebuild; retry this package.',
				)
			}
			await rebuildPublishedPackageArtifactsViaRepoSession({
				env: input.env,
				rpcSessionId: `pre-binding-rebuild-${savedPackage.sourceId}`,
				sourceId: savedPackage.sourceId,
				userId: savedPackage.userId,
				publishedCommit,
				baseUrl: input.baseUrl,
				targets: scan.stale,
				force: true,
			})
			const afterRebuild = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			if ((afterRebuild.published_commit?.trim() || null) !== publishedCommit) {
				throw new Error(
					'Published commit changed during the pre-binding rebuild; retry this package.',
				)
			}
			const after = await findStaleTargets({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				targets: scan.stale,
			})
			// Every rebuilt target must now be stored at this commit and bound.
			const notRebuilt = after.stale.length + after.notCurrent.length
			if (notRebuilt > 0) {
				result.stillStaleAfterRebuild += 1
				throw new Error(
					`${notRebuilt} target(s) not current after rebuild (${after.stale.length} still pre-binding, ${after.notCurrent.length} missing or at another commit).`,
				)
			}
			result.rebuiltPackages += 1
			result.outcomes.push({
				...base,
				publishedCommit,
				staleTargets: staleCount,
				staleMultiPackageTargets: multiCount,
				outcome: 'rebuilt',
			})
		} catch (error) {
			result.failedPackages += 1
			result.outcomes.push({
				...base,
				publishedCommit,
				staleTargets: staleCount,
				staleMultiPackageTargets: multiCount,
				outcome: 'failed',
				error: getErrorMessage(error),
			})
		}
	}
	return result
}
