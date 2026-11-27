import * as Sentry from '@sentry/cloudflare'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { EnablerCredential } from '#worker/enablements/owner-cron-enablement.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	advanceEntitySourceServingCommit,
	getEntitySourceById,
	holdEntitySourceCommit,
} from '#worker/repo/entity-sources.ts'
import { updatePackageServing } from '#worker/repo/package-serving-update.ts'
import { approvedCommitCache } from './approved-commit-cache.ts'
import {
	getServedPackageCapabilityApproval,
	hasPackageCapabilityApprovalForCommit,
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
 * Start serving `commit` once its build is complete. Every runtime reader
 * (members, the owner, jobs and anonymous visitors) follows the serving
 * commit, so this is when everyone switches versions.
 *
 * For an internet-visible app with an approved commit that served:
 * - a commit whose capability set stays within that approval carries it
 *   forward in the same D1 transaction as the pointer move, so no request
 *   sees the new serving commit before its approval exists;
 * - a wider set (or one that could not be checked) does not serve. The
 *   source records it as `held_commit` and everyone stays on the approved
 *   commit until the owner approves it (`releaseHeldServingCommit`).
 *
 * Other apps and packages advance as soon as the build is complete
 * (ADR 0069).
 */
/** Who made the commit serve; jobs it adds are enabled as them. */
export type ServingAdvanceActor = {
	userId?: PersonId
	credential?: EnablerCredential | null
}

type ServingAdvanceInput = {
	env: Env
	sourceId: string
	userId: OwnerId
	commit: string
	actor?: ServingAdvanceActor
}

export async function advanceServingCommit(
	input: ServingAdvanceInput,
): Promise<boolean> {
	const { env, ...update } = input
	const result = await updatePackageServing(env, { kind: 'advance', ...update })
	if (result.advanced && result.packageId) {
		approvedCommitCache.delete(result.packageId)
	}
	if (result.heldPackageId) {
		await settleProjection(input, result.heldPackageId)
	}
	return result.advanced
}

/** Runs on the source's serving update queue, including job reconciliation. */
export async function advancePackageServingCommit(
	input: ServingAdvanceInput,
): Promise<{ advanced: boolean; packageId?: string; heldPackageId?: string }> {
	let decision = await decideServingAdvance(input)
	if (decision?.hold) {
		const held = await holdEntitySourceCommit(input.env.APP_DB, {
			id: input.sourceId,
			userId: input.userId,
			commit: input.commit,
		})
		if (held) {
			// One notice per held commit: a republish of the same commit holds
			// it again without telling the owners twice.
			if (!decision.alreadyHeld) {
				const { notifyOwnersOfHeldPublish } =
					await import('./held-for-approval-notice.ts')
				await notifyOwnersOfHeldPublish({
					env: input.env,
					ownerUserId: input.userId,
					packageId: decision.packageId,
				})
			}
			return { advanced: false, heldPackageId: decision.packageId }
		}
		// An approval or visibility change landed while deciding: decide again.
		decision = await decideServingAdvance(input)
		if (decision?.hold) return { advanced: false }
	}
	return {
		advanced: await advanceToServing(input, decision),
		packageId: decision?.packageId,
	}
}

async function advanceToServing(
	input: ServingAdvanceInput,
	decision: Exclude<ServingAdvanceDecision, { hold: true }> | null,
): Promise<boolean> {
	// Jobs switch with the code. A sync that fails throws before the pointer
	// moves, so the commit is not served and a retry runs the sync again.
	if (!(await syncJobsToCommit(input))) return false
	const advanced = await advanceEntitySourceServingCommit(
		input.env.APP_DB,
		{ id: input.sourceId, userId: input.userId, commit: input.commit },
		decision?.carryForward ? [decision.carryForward] : [],
		decision
			? [
					prepareMarkServedPackageCapabilityApprovals(input.env.APP_DB, {
						sourceId: input.sourceId,
						userId: input.userId,
						commit: input.commit,
					}),
				]
			: [],
	)
	if (advanced && decision) {
		approvedCommitCache.delete(decision.packageId)
	}
	return advanced
}

/**
 * Serve the source's held commit when it no longer needs to wait: its
 * capabilities were approved, or its app is no longer internet-visible.
 * No-op when nothing is held or a newer publish superseded the held commit.
 */
export async function releaseHeldServingCommit(input: {
	env: Env
	sourceId: string
	userId: OwnerId
	/** Who approved or turned internet-visible off. */
	actorUserId?: string | null
}): Promise<boolean> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (
		!source ||
		source.user_id !== input.userId ||
		!source.held_commit ||
		source.held_commit !== source.published_commit
	) {
		return false
	}
	const advanced = await advanceServingCommit({
		env: input.env,
		sourceId: source.id,
		userId: input.userId,
		commit: source.held_commit,
		...(input.actorUserId
			? { actor: { userId: personIdFromStored(input.actorUserId) } }
			: {}),
	})
	if (advanced) {
		await settleProjection(
			{ env: input.env, sourceId: source.id, userId: input.userId },
			source.entity_id,
		)
	}
	return advanced
}

async function syncJobsToCommit(input: ServingAdvanceInput) {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (
		!source ||
		source.user_id !== input.userId ||
		source.entity_kind !== 'package' ||
		source.published_commit !== input.commit
	) {
		return false
	}
	const { syncPublishedPackageJobs } = await import('#worker/jobs/service.ts')
	await syncPublishedPackageJobs({
		env: input.env,
		userId: input.userId,
		baseUrl: getAppBaseUrl({ env: input.env }),
		packageId: source.entity_id,
		sourceId: source.id,
		commit: input.commit,
		actorUserId: input.actor?.userId,
		actorCredential: input.actor?.credential ?? null,
	}).catch((error: unknown) => {
		throw new Error(
			`Failed while rebinding package jobs: ${getErrorMessage(error)}`,
			{
				cause: error,
			},
		)
	})
	return true
}

/**
 * Subscriptions, skills, and package metadata follow the commit everyone
 * runs: publish projected the held commit, so a hold settles them back, and a
 * release moves them on with the code.
 */
async function settleProjection(
	input: { env: Env; sourceId: string; userId: OwnerId },
	packageId: string,
) {
	// The same settle a failed publish rebuild runs (settleFailedPublishRebuild).
	const { refreshSavedPackageProjection } =
		await import('#worker/package-registry/service.ts')
	try {
		await refreshSavedPackageProjection({
			env: input.env,
			baseUrl: getAppBaseUrl({ env: input.env }),
			userId: input.userId,
			packageId,
			sourceId: input.sourceId,
			rebuildArtifacts: false,
			audit: null,
		})
	} catch (error) {
		console.error('held-commit-projection-settle-failed', {
			sourceId: input.sourceId,
			packageId,
			error,
		})
		Sentry.captureException(error, {
			tags: { scope: 'held-commit-projection-settle' },
			extra: { sourceId: input.sourceId, packageId },
		})
	}
}

type ServingAdvanceDecision =
	| {
			hold: true
			packageId: string
			/** `commit` was already recorded as held before this decision. */
			alreadyHeld: boolean
	  }
	| {
			hold: false
			/** The package app whose approvals for `commit` are marked served. */
			packageId: string
			carryForward: D1PreparedStatement | null
	  }

async function decideServingAdvance(input: {
	env: Env
	sourceId: string
	userId: OwnerId
	commit: string
}): Promise<ServingAdvanceDecision | null> {
	const db = input.env.APP_DB
	let appPackageId: string | null = null
	let alreadyHeld = false
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
		alreadyHeld = source.held_commit === input.commit
		const savedPackage = await getSavedPackageById(db, {
			userId: input.userId,
			packageId: source.entity_id,
		})
		if (!savedPackage?.hasApp) return null
		appPackageId = savedPackage.id
		const advance = {
			hold: false as const,
			packageId: savedPackage.id,
			carryForward: null,
		}
		if (!savedPackage.isInternetVisible) return advance
		// An app never approved for the public has nothing to carry forward.
		const served = await getServedPackageCapabilityApproval(db, {
			packageId: savedPackage.id,
			ownerUserId: savedPackage.userId,
			sourceId: source.id,
		})
		if (!served || served.publishedCommit === input.commit) return advance
		if (
			await hasPackageCapabilityApprovalForCommit(db, {
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				publishedCommit: input.commit,
			})
		) {
			return advance
		}
		if (alreadyHeld) {
			return { hold: true, packageId: savedPackage.id, alreadyHeld }
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
			return { hold: true, packageId: savedPackage.id, alreadyHeld }
		}
		return {
			...advance,
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
		// Everyone keeps the approved commit they run now; the owner can
		// approve the new one from the approval page.
		console.warn('approval-carry-forward-failed', {
			sourceId: input.sourceId,
			commit: input.commit,
			error: error instanceof Error ? error.message : String(error),
		})
		return appPackageId
			? { hold: true, packageId: appPackageId, alreadyHeld }
			: null
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
