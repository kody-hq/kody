import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	advanceEntitySourceServingCommit,
	getEntitySourceById,
} from '#worker/repo/entity-sources.ts'
import { approvedCommitCache } from './approved-commit-cache.ts'
import {
	getServedPackageCapabilityApproval,
	prepareCarriedForwardPackageCapabilityApproval,
	prepareMarkServedPackageCapabilityApprovals,
	type PackageCapabilityApprovalRecord,
} from './capability-approvals-repo.ts'
import {
	capabilityEntriesWithin,
	type CapabilitySet,
	type CapabilitySetEntry,
} from './capability-set.ts'
import { computePackageCapabilitySet } from './compute-package-capability-set.ts'
import { serializeDependencySnapshot } from './dependency-snapshot.ts'

/**
 * Start serving `commit` once its build is complete. For an internet-visible
 * app this is when anonymous visitors switch versions, so a commit whose
 * capability set stays within the approval visitors run now carries that
 * approval forward in the same D1 transaction as the pointer move: no request
 * sees the new serving commit before its approval exists. A wider set writes
 * nothing, and visitors keep the previous approved commit until the owner
 * approves the new one (ADR 0069).
 */
export async function advanceServingCommit(input: {
	env: Env
	sourceId: string
	userId: OwnerId
	commit: string
}): Promise<boolean> {
	const approvals = await prepareServingApprovals(input)
	const advanced = await advanceEntitySourceServingCommit(
		input.env.APP_DB,
		{ id: input.sourceId, userId: input.userId, commit: input.commit },
		approvals?.carryForward ? [approvals.carryForward] : [],
		approvals
			? [
					prepareMarkServedPackageCapabilityApprovals(input.env.APP_DB, {
						sourceId: input.sourceId,
						userId: input.userId,
						commit: input.commit,
					}),
				]
			: [],
	)
	if (advanced && approvals) {
		approvedCommitCache.delete(approvals.packageId)
	}
	return advanced
}

/**
 * For a package app: its id (its approvals for `commit` are marked served
 * with the advance) and the carried-forward approval, when there is one.
 */
async function prepareServingApprovals(input: {
	env: Env
	sourceId: string
	userId: OwnerId
	commit: string
}): Promise<{
	packageId: string
	carryForward: D1PreparedStatement | null
} | null> {
	const db = input.env.APP_DB
	let appPackageId: string | null = null
	try {
		const source = await getEntitySourceById(db, input.sourceId)
		if (
			!source ||
			source.user_id !== input.userId ||
			source.entity_kind !== 'package' ||
			source.published_commit !== input.commit ||
			source.serving_commit === input.commit
		) {
			return null
		}
		const savedPackage = await getSavedPackageById(db, {
			userId: input.userId,
			packageId: source.entity_id,
		})
		if (!savedPackage?.hasApp) return null
		appPackageId = savedPackage.id
		const withoutCarryForward = {
			packageId: savedPackage.id,
			carryForward: null,
		}
		if (!savedPackage.isInternetVisible) return withoutCarryForward
		// An app never approved for the public has nothing to carry forward.
		const served = await getServedPackageCapabilityApproval(db, {
			packageId: savedPackage.id,
			ownerUserId: savedPackage.userId,
			sourceId: source.id,
		})
		if (!served || served.publishedCommit === input.commit) {
			return withoutCarryForward
		}
		const computed = await computePackageCapabilitySet({
			env: input.env,
			ownerUserId: savedPackage.userId,
			packageId: savedPackage.id,
			packageKodyId: savedPackage.kodyId,
			sourceId: source.id,
			requestUrl: getAppBaseUrl({ env: input.env }),
			publishedCommit: input.commit,
		})
		if (!capabilitySetWithinApproval(computed.capabilitySet, served)) {
			return withoutCarryForward
		}
		return {
			packageId: savedPackage.id,
			carryForward: prepareCarriedForwardPackageCapabilityApproval(db, {
				id: crypto.randomUUID(),
				package_id: savedPackage.id,
				owner_user_id: savedPackage.userId,
				source_id: source.id,
				published_commit: input.commit,
				fingerprint: computed.capabilitySet.fingerprint,
				capability_set_json: JSON.stringify(computed.capabilitySet.entries),
				dependency_snapshot_json: serializeDependencySnapshot(
					computed.dependencySnapshot,
				),
				approved_by_user_id: served.approvedByUserId,
				approved_at: new Date().toISOString(),
			}),
		}
	} catch (error) {
		// Visitors keep the approved commit they run now; the owner can approve
		// the new one from the approval page.
		console.warn('approval-carry-forward-failed', {
			sourceId: input.sourceId,
			commit: input.commit,
			error: error instanceof Error ? error.message : String(error),
		})
		return appPackageId ? { packageId: appPackageId, carryForward: null } : null
	}
}

function capabilitySetWithinApproval(
	capabilitySet: CapabilitySet,
	approval: PackageCapabilityApprovalRecord,
) {
	if (capabilitySet.fingerprint === approval.fingerprint) return true
	let approvedEntries: unknown
	try {
		approvedEntries = JSON.parse(approval.capabilitySetJson)
	} catch {
		return false
	}
	if (!Array.isArray(approvedEntries)) return false
	return capabilityEntriesWithin(
		capabilitySet.entries,
		approvedEntries as Array<CapabilitySetEntry>,
	)
}
