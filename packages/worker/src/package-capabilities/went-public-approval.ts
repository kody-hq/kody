import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	enqueuePackageApprovalRequest,
	getPendingPackageApprovalRequest,
	type PackageApprovalRequest,
	setPendingPackageApprovalRequestFlag,
} from './approval-requests-repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

/**
 * Enqueue (or reuse) a `went_public` approval request for a package that is
 * about to become internet-visible. Does not flip `is_internet_visible` —
 * the owner Approves on the capability page.
 */
export async function enqueueWentPublicApproval(input: {
	env: Env
	ownerUserId: OwnerId | string
	savedPackage: SavedPackageRecord
	publishedCommit: string
	fingerprint: string
	requestedByUserId: string | null
	/** Set only by self-publish, which approves the request itself. */
	selfPublish?: boolean
}): Promise<PackageApprovalRequest> {
	return enqueuePackageApprovalRequest(input.env.APP_DB, {
		packageId: input.savedPackage.id,
		ownerUserId: input.ownerUserId,
		reason: 'went_public',
		pendingCommit: input.publishedCommit,
		baseCommit: input.publishedCommit,
		details: {
			fingerprint: input.fingerprint,
			summary: 'Serve this package on the public internet.',
			...(input.selfPublish ? { [selfPublishDetailKey]: true } : {}),
		},
		requestedByUserId: input.requestedByUserId,
	})
}

/** `went_public` details key marking a request self-publish approved. */
export const selfPublishDetailKey = 'selfPublish'

export function isSelfPublishRequest(request: PackageApprovalRequest | null) {
	return request?.details[selfPublishDetailKey] === true
}

/** Marks or unmarks a still-pending request; false when it was resolved. */
export async function setSelfPublishMark(
	env: Env,
	requestId: string,
	marked: boolean,
) {
	return setPendingPackageApprovalRequestFlag(env.APP_DB, {
		id: requestId,
		key: selfPublishDetailKey,
		value: marked,
	})
}

export async function getPendingWentPublicApproval(input: {
	env: Env
	ownerUserId: OwnerId | string
	packageId: string
}): Promise<PackageApprovalRequest | null> {
	return getPendingPackageApprovalRequest(input.env.APP_DB, {
		packageId: input.packageId,
		ownerUserId: input.ownerUserId,
		reason: 'went_public',
	})
}

/**
 * Published commit for a package source owned by `ownerUserId`, or null.
 */
export async function readPublishedCommitForPackage(input: {
	env: Env
	ownerUserId: OwnerId | string
	sourceId: string
}): Promise<string | null> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.ownerUserId) return null
	return source.published_commit ?? null
}

export function readWentPublicSummary(
	details: Record<string, unknown>,
): string {
	const summary = details['summary']
	return typeof summary === 'string' && summary.trim()
		? summary.trim()
		: 'Serve this package on the public internet.'
}
