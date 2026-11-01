import { approvedCommitCache } from './approved-commit-cache.ts'
import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { computePackageCapabilitySet } from './compute-package-capability-set.ts'
import {
	findPackageCapabilityApprovalByFingerprint,
	getLatestPackageCapabilityApproval,
	insertPackageCapabilityApproval,
	isEmptyDependencySnapshotJson,
	updatePackageCapabilityApprovalSnapshot,
	type PackageCapabilityApprovalRecord,
} from './capability-approvals-repo.ts'
import {
	buildCapabilitySet,
	capabilitySetsEqual,
	type CapabilitySet,
} from './capability-set.ts'
import {
	emptyDependencySnapshot,
	serializeDependencySnapshot,
	type PackageDependencySnapshot,
} from './dependency-snapshot.ts'
import {
	getSavedPackageById,
	nextSavedPackageUpdatedAt,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	getPendingPackageApprovalRequest,
	resolvePackageApprovalRequest,
	type PackageApprovalRequest,
} from './approval-requests-repo.ts'
import { enqueueWentPublicApproval } from './went-public-approval.ts'

export type CapabilityApprovalSummary = {
	capabilitySet: CapabilitySet
	dependencySnapshot: PackageDependencySnapshot | null
	publishedCommit: string | null
	latestApproval: PackageCapabilityApprovalRecord | null
	/** Approval row for the current fingerprint, if any (not necessarily latest). */
	matchingApproval: PackageCapabilityApprovalRecord | null
	fingerprintMatchesApproval: boolean
	isInternetVisible: boolean
}

export async function loadCapabilityApprovalSummary(input: {
	env: Env
	ownerUserId: OwnerId
	savedPackage: SavedPackageRecord
	requestUrl: string
}): Promise<CapabilityApprovalSummary> {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.savedPackage.sourceId,
	)
	const publishedCommit =
		source?.user_id === input.ownerUserId
			? (source.published_commit ?? null)
			: null

	const latestApproval = await getLatestPackageCapabilityApproval(
		input.env.APP_DB,
		{
			packageId: input.savedPackage.id,
			ownerUserId: input.ownerUserId,
		},
	)

	// Unpublished packages cannot load a published manifest. Return an empty
	// placeholder so the approval page / toggle can show "publish first"
	// instead of throwing.
	if (!publishedCommit) {
		const capabilitySet = await buildCapabilitySet([])
		return {
			capabilitySet,
			dependencySnapshot: null,
			publishedCommit: null,
			latestApproval,
			matchingApproval: null,
			fingerprintMatchesApproval: false,
			isInternetVisible: input.savedPackage.isInternetVisible,
		}
	}

	const computed = await computePackageCapabilitySet({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.savedPackage.id,
		packageKodyId: input.savedPackage.kodyId,
		sourceId: input.savedPackage.sourceId,
		requestUrl: input.requestUrl,
		publishedCommit,
	})

	const matchingApproval = await findPackageCapabilityApprovalByFingerprint(
		input.env.APP_DB,
		{
			packageId: input.savedPackage.id,
			ownerUserId: input.ownerUserId,
			fingerprint: computed.capabilitySet.fingerprint,
		},
	)

	return {
		capabilitySet: computed.capabilitySet,
		dependencySnapshot: computed.dependencySnapshot,
		publishedCommit,
		latestApproval,
		matchingApproval,
		fingerprintMatchesApproval: matchingApproval != null,
		isInternetVisible: input.savedPackage.isInternetVisible,
	}
}

export async function approvePackageCapabilitySet(input: {
	env: Env
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	requestUrl: string
	/** Fingerprint the owner reviewed; must match the live set. */
	expectedFingerprint: string
	/**
	 * False when the caller approves an existing `went_public` request itself,
	 * so a request turned off meanwhile is not enqueued again.
	 */
	enqueueWentPublic?: boolean
	/**
	 * Owner Approve UI (package page and approval bundles). Always insert a new
	 * pin row for the live fingerprint + commit so a prior pin for the same
	 * fingerprint cannot no-op and leave a stale capability_set_json. Republish
	 * accept keeps the default false so identical pins stay quiet.
	 */
	recordPin?: boolean
}): Promise<{
	approval: PackageCapabilityApprovalRecord
	capabilitySet: CapabilitySet
	/** Pending `went_public` request when this approve is the path to going public. */
	wentPublicRequest: PackageApprovalRequest | null
}> {
	const summary = await loadCapabilityApprovalSummary({
		env: input.env,
		ownerUserId: input.ownerUserId,
		savedPackage: input.savedPackage,
		requestUrl: input.requestUrl,
	})
	if (!summary.publishedCommit) {
		throw new CapabilityApprovalError(
			'Publish the package before approving internet-visible capabilities.',
		)
	}
	const expected = input.expectedFingerprint.trim()
	if (!expected) {
		throw new CapabilityApprovalError(
			'Reload the approval page and approve the current capability summary.',
		)
	}
	if (expected !== summary.capabilitySet.fingerprint) {
		throw new CapabilityApprovalError(
			'The capability set changed since you loaded this page. Reload, review the updated summary, and approve again.',
		)
	}

	const existing = await findPackageCapabilityApprovalByFingerprint(
		input.env.APP_DB,
		{
			packageId: input.savedPackage.id,
			ownerUserId: input.ownerUserId,
			fingerprint: summary.capabilitySet.fingerprint,
			publishedCommit: summary.publishedCommit,
		},
	)
	const now = new Date().toISOString()
	const dependencySnapshotJson = serializeDependencySnapshot(
		summary.dependencySnapshot ??
			emptyDependencySnapshot({
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
				publishedCommit: summary.publishedCommit,
			}),
	)
	const capabilitySetJson = JSON.stringify(summary.capabilitySet.entries)
	let approval = existing
	const existingSnapshotEmpty =
		existing != null &&
		isEmptyDependencySnapshotJson(existing.dependencySnapshotJson)
	const existingSnapshotDrifted =
		existing != null &&
		!existingSnapshotEmpty &&
		existing.dependencySnapshotJson !== dependencySnapshotJson
	if (existing && existingSnapshotEmpty && !input.recordPin) {
		// PR1 rows stored "{}". Backfill the real pin on re-approve so
		// internet-visible serving can read a lockfile.
		approval =
			(await updatePackageCapabilityApprovalSnapshot(input.env.APP_DB, {
				id: existing.id,
				dependencySnapshotJson,
				capabilitySetJson,
				approvedByUserId: input.actorUserId,
				approvedAt: now,
			})) ?? existing
	} else if (
		!existing ||
		existingSnapshotDrifted ||
		input.recordPin === true ||
		(existing != null && existing.capabilitySetJson !== capabilitySetJson)
	) {
		// Same capability fingerprint can still pin a newer dependency tree
		// (decision 4: fingerprint drives re-prompt; the lockfile still moves).
		// Owner Approve always inserts so a matching fingerprint cannot no-op
		// past a stale capability_set_json (visitor-flag pin bug).
		approval = await insertPackageCapabilityApproval(input.env.APP_DB, {
			id: crypto.randomUUID(),
			package_id: input.savedPackage.id,
			owner_user_id: input.ownerUserId,
			published_commit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			capability_set_json: capabilitySetJson,
			dependency_snapshot_json: dependencySnapshotJson,
			approved_by_user_id: input.actorUserId,
			approved_at: now,
		})
	}

	if (!approval) {
		throw new CapabilityApprovalError('Could not record capability approval.')
	}
	approvedCommitCache.delete(input.savedPackage.id)

	// Going public pauses on the shared approval queue (`went_public`). The
	// owner Approves that request to flip internet-visible. Re-approving an
	// already-public package only refreshes the capability pin (storage-change
	// trigger stays on the fingerprint match, not the queue).
	let wentPublicRequest: PackageApprovalRequest | null = null
	if (
		!input.savedPackage.isInternetVisible &&
		input.enqueueWentPublic !== false
	) {
		wentPublicRequest = await enqueueWentPublicApproval({
			env: input.env,
			ownerUserId: input.ownerUserId,
			savedPackage: input.savedPackage,
			publishedCommit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			requestedByUserId: input.actorUserId,
		})
	}

	return {
		approval,
		capabilitySet: summary.capabilitySet,
		wentPublicRequest,
	}
}

export async function clearInternetVisible(input: {
	env: Env
	ownerUserId: OwnerId | string
	packageId: string
	/** Who turned internet-visible off; supersedes a pending went_public. */
	actorUserId?: string | null
}): Promise<boolean> {
	// Supersede first so a concurrent Approve cannot claim the pending row
	// after we decide to turn public serving off.
	const pending = await getPendingPackageApprovalRequest(input.env.APP_DB, {
		packageId: input.packageId,
		ownerUserId: input.ownerUserId,
		reason: 'went_public',
	})
	if (pending) {
		await resolvePackageApprovalRequest(input.env.APP_DB, {
			id: pending.id,
			status: 'superseded',
			resolvedByUserId: input.actorUserId ?? null,
		})
	}
	approvedCommitCache.delete(input.packageId)
	const live = await getSavedPackageById(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: input.packageId,
	})
	if (!live) {
		return pending != null
	}
	// Always advance updated_at past the live stamp so a concurrent approve
	// that claimed the row then CAS-enables on the old stamp fails closed.
	const changed = await updateSavedPackage(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: input.packageId,
		isInternetVisible: false,
		updatedAt: nextSavedPackageUpdatedAt(live.updatedAt),
		audit: optionalOrgAuditWriter(input.env, {
			userId: input.actorUserId ?? null,
		}),
	})
	// Package missing → false. Already-off with a superseded pending → true so
	// MCP/settings can cancel a went_public without requiring the flag on.
	return changed || pending != null
}

export function approvalMatchesCurrentSet(input: {
	currentFingerprint: string
	approval: PackageCapabilityApprovalRecord | null
}) {
	if (!input.approval) return false
	return capabilitySetsEqual(
		input.currentFingerprint,
		input.approval.fingerprint,
	)
}

export class CapabilityApprovalError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CapabilityApprovalError'
	}
}
