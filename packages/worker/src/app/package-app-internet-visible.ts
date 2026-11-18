import type { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { approvedCommitCache } from '#worker/package-capabilities/approved-commit-cache.ts'
import { getServedPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'

type PackageAppSlugLookup = Awaited<
	ReturnType<typeof resolveSavedPackageForPackageAppSlug>
>

/**
 * The published commit anonymous visitors of an internet-visible app run
 * (ADR 0069), or null when the app is not internet-visible or its owner never
 * approved a capability set for it. That is the serving commit once it has an
 * approval (carried forward when it serves, see `advanceServingCommit`), else
 * the previous approved commit while a wider republish awaits the owner.
 */
export async function resolveInternetVisibleApprovedCommit(input: {
	env: Env
	lookup: PackageAppSlugLookup
}): Promise<string | null> {
	const savedPackage = input.lookup?.savedPackage
	if (!savedPackage?.hasApp || !savedPackage.isInternetVisible) return null
	return await approvedCommitCache.getOrCreate({
		cacheKey: savedPackage.id,
		create: async () => {
			const approval = await getServedPackageCapabilityApproval(
				input.env.APP_DB,
				{
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					sourceId: savedPackage.sourceId,
				},
			)
			return approval?.publishedCommit ?? null
		},
	})
}
