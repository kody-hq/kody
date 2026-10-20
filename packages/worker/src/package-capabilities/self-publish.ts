/**
 * Self-publish (issue #3822): an agent's request to make a package
 * internet-visible is approved without the owner's click when the resolved
 * capability set is empty (nothing for the owner to approve), nothing in the
 * package's resolved dependency tree declares a credential or any other
 * capability, and a security audit with verdict `pass` is recorded for the
 * package's current published commit and capability fingerprint. It is tried
 * when `packageUpdate` or the settings toggle turns internet-visible on, and
 * again when `packageSecurityAuditRecord` records a pass while a `went_public`
 * request is pending. The credential door refuses every credential to a
 * self-published package (`assertSelfPublishedPackageResolvesNothing`), which
 * covers the by-name helpers credential-need enforcement does not reach — so
 * self-publish does not wait on that flag.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	AuthorizationError,
	authorizePackageWrite,
} from '#worker/authorization/authorize.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { approveWentPublicRequest } from '#app/account-package-approval-requests.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import {
	approvePackageCapabilitySet,
	type CapabilityApprovalSummary,
} from './capability-approval-service.ts'
import {
	enqueueWentPublicApproval,
	getPendingWentPublicApproval,
	isSelfPublishRequest,
	setSelfPublishMark,
} from './went-public-approval.ts'
import { loadCurrentPackageSecurityAudit } from './security-audit-state.ts'
import { findPublishedPackageStorageMatches } from './package-storage-use.ts'
import {
	buildSelfPublishBlockerDetail,
	credentialAndStorageReasonsFromEntries,
	selfPublishCapabilityManifestFields,
	type SelfPublishBlocker,
	type SelfPublishBlockerDetail,
	type SelfPublishBlockerReason,
	type SelfPublishCapabilityManifestField,
} from './self-publish-blocker-detail.ts'

export const selfPublishAuditAction = 'package.went_public.self_publish'

export type {
	SelfPublishBlocker,
	SelfPublishBlockerDetail,
	SelfPublishBlockerReason,
} from './self-publish-blocker-detail.ts'

export type SelfPublishEligibility =
	| { eligible: true }
	| {
			eligible: false
			blocker: SelfPublishBlocker
			reasons: Array<SelfPublishBlockerReason>
	  }

function declaresAny(value: unknown) {
	if (value == null) return false
	if (Array.isArray(value)) return value.length > 0
	if (typeof value === 'object') return Object.keys(value).length > 0
	return true
}

type TreePackageResult =
	| { blocker: null }
	| {
			blocker: SelfPublishBlocker
			reasons: Array<SelfPublishBlockerReason>
	  }

async function evaluateTreePackage(
	env: Env,
	sourceId: string,
	pinnedCommit: string,
): Promise<TreePackageResult> {
	const source = await getEntitySourceById(env.APP_DB, sourceId)
	if (!source?.published_commit) {
		return {
			blocker: 'unpublished',
			reasons: [{ kind: 'unpublished', sourceId }],
		}
	}
	// Only the published version is read, so it has to be the one serving pins.
	if (source.published_commit !== pinnedCommit) {
		return {
			blocker: 'stale_dependencies',
			reasons: [
				{
					kind: 'stale_dependencies',
					sourceId,
					pinnedCommit,
					livePublishedCommit: source.published_commit,
				},
			],
		}
	}
	const { manifest } = await loadPublishedEntityManifest({
		env,
		userId: source.user_id,
		sourceId,
		source,
	})
	const kody = manifest.kody
	if (
		declaresAny(kody.credentials) ||
		declaresAny(kody.invalidCredentialSlots)
	) {
		const needKeys = Object.keys(
			(kody.credentials ?? {}) as Record<string, unknown>,
		)
		return {
			blocker: 'declares_credentials',
			reasons: [
				{
					kind: 'credential_needs',
					sourceId,
					needCount: Math.max(1, needKeys.length),
				},
			],
		}
	}
	const declaredFields = selfPublishCapabilityManifestFields.filter((field) =>
		declaresAny(kody[field]),
	)
	if (declaredFields.length > 0) {
		return {
			blocker: 'declares_capabilities',
			reasons: declaredFields.map((field) => ({
				kind: 'manifest_field' as const,
				field: field as SelfPublishCapabilityManifestField,
				sourceId,
			})),
		}
	}
	const needs = await loadPublishedCredentialNeeds({
		env,
		userId: source.user_id,
		sourceId,
		fresh: true,
	})
	if (needs.length > 0) {
		return {
			blocker: 'declares_credentials',
			reasons: [
				{ kind: 'credential_needs', sourceId, needCount: needs.length },
			],
		}
	}
	return { blocker: null }
}

async function storageMatchesForEntries(input: {
	env: Env
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
}): Promise<
	Map<string, Awaited<ReturnType<typeof findPublishedPackageStorageMatches>>>
> {
	const byPackageId = new Map<
		string,
		Awaited<ReturnType<typeof findPublishedPackageStorageMatches>>
	>()
	const storageEntries = input.summary.capabilitySet.entries.filter(
		(entry) => entry.kind === 'storage' && entry.storageId,
	)
	if (storageEntries.length === 0) return byPackageId

	const rootSourceId = input.savedPackage.sourceId
	const publishedCommit = input.summary.publishedCommit
	if (!publishedCommit) return byPackageId

	// Root package storage is the common case (slide decks, static apps).
	const rootMatches = await findPublishedPackageStorageMatches({
		env: input.env,
		sourceId: rootSourceId,
		publishedCommit,
	})
	byPackageId.set(input.savedPackage.id, rootMatches)

	for (const dependency of input.summary.dependencySnapshot?.dependencies ??
		[]) {
		if (!dependency.packageId || !dependency.sourceId) continue
		if (byPackageId.has(dependency.packageId)) continue
		if (
			!storageEntries.some((entry) => entry.storageId === dependency.packageId)
		) {
			continue
		}
		byPackageId.set(
			dependency.packageId,
			await findPublishedPackageStorageMatches({
				env: input.env,
				sourceId: dependency.sourceId,
				publishedCommit: dependency.publishedCommit,
			}),
		)
	}
	return byPackageId
}

/**
 * Whether going internet-visible may skip the owner's Approve: the capability
 * set the owner would see is empty, the package and every package in its
 * resolved dependency tree are published and declare no credential and no
 * capability, and the current published commit + fingerprint has a passing
 * security audit.
 */
export async function evaluateSelfPublish(input: {
	env: Env
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
}): Promise<SelfPublishEligibility> {
	if (!input.summary.publishedCommit) {
		return {
			eligible: false,
			blocker: 'unpublished',
			reasons: [{ kind: 'unpublished', sourceId: input.savedPackage.sourceId }],
		}
	}
	// The approval page lists these entries. Anything here is something for
	// the owner to approve (credentials, hosts, or storage); agents must not.
	const entries = input.summary.capabilitySet.entries
	if (entries.length > 0) {
		const storageMatches = await storageMatchesForEntries(input)
		const fromEntries = credentialAndStorageReasonsFromEntries(
			entries,
			storageMatches,
		)
		return {
			eligible: false,
			blocker: fromEntries?.blocker ?? 'declares_capabilities',
			reasons: fromEntries?.reasons ?? [],
		}
	}
	const pinned = new Map([
		[input.savedPackage.sourceId, input.summary.publishedCommit],
		...(input.summary.dependencySnapshot?.dependencies ?? []).map(
			(dependency) =>
				[dependency.sourceId, dependency.publishedCommit] as const,
		),
	])
	for (const [sourceId, commit] of pinned) {
		const result = await evaluateTreePackage(input.env, sourceId, commit)
		if (result.blocker) {
			return {
				eligible: false,
				blocker: result.blocker,
				reasons: result.reasons,
			}
		}
	}
	const audit = await loadCurrentPackageSecurityAudit(input.env.APP_DB, {
		ownerUserId: input.savedPackage.userId,
		packageId: input.savedPackage.id,
		publishedCommit: input.summary.publishedCommit,
		fingerprint: input.summary.capabilitySet.fingerprint,
	})
	if (!audit) {
		return {
			eligible: false,
			blocker: 'not_audited',
			reasons: [{ kind: 'not_audited' }],
		}
	}
	if (audit.verdict !== 'pass') {
		return {
			eligible: false,
			blocker: 'audit_concerns',
			reasons: [{ kind: 'audit_concerns' }],
		}
	}
	return { eligible: true }
}

/**
 * Explain why self-publish does not apply for this summary, without attempting
 * to publish. Used by the approval page and agent responses.
 */
export async function explainSelfPublishBlocker(input: {
	env: Env
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
	approvalUrl?: string
}): Promise<SelfPublishBlockerDetail | null> {
	const eligibility = await evaluateSelfPublish(input)
	if (eligibility.eligible) return null
	return buildSelfPublishBlockerDetail({
		blocker: eligibility.blocker,
		reasons: eligibility.reasons,
		approvalUrl: input.approvalUrl,
	})
}

export type SelfPublishResult = { ok: true } | { ok: false; error: string }

/**
 * Makes an eligible package internet-visible: records the capability pin and
 * a `went_public` request marked self-publish, approves that request through
 * the owner's own approval code, and audits the decision once. Call only
 * after {@link evaluateSelfPublish} returned eligible for this summary.
 */
export async function selfPublishPackage(input: {
	env: Env
	request: RequestContext
	requestUrl: string
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
	/**
	 * The pending `went_public` request the caller saw. Only that request is
	 * marked and approved; none is enqueued, so a request the owner withdrew
	 * meanwhile is never replaced.
	 */
	pendingRequestId?: string
}): Promise<SelfPublishResult> {
	const { env, savedPackage } = input
	const fingerprint = input.summary.capabilitySet.fingerprint
	const audit = (
		result: 'success' | 'failure',
		details: Record<string, unknown>,
	) =>
		logOrgAuditEvent({
			env,
			orgId: input.ownerUserId,
			action: selfPublishAuditAction,
			result,
			actorUserId: input.request.actor?.userId ?? input.actorUserId,
			actorUsername: input.request.actor?.username ?? null,
			credentialKind: input.request.credential.kind,
			credentialId: input.request.credential.id,
			resourceType: 'package',
			resourceId: savedPackage.id,
			details: {
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				fingerprint,
				publishedCommit: input.summary.publishedCommit,
				...details,
			},
		}).catch((error: unknown) => {
			console.error('Failed to audit self-publish:', {
				packageId: savedPackage.id,
				error: getErrorMessage(error),
			})
		})
	const approved = await approvePackageCapabilitySet({
		env,
		ownerUserId: input.ownerUserId,
		actorUserId: input.actorUserId,
		savedPackage,
		requestUrl: input.requestUrl,
		expectedFingerprint: fingerprint,
		enqueueWentPublic: false,
	})
	// The audit vouches for one commit. A publish since evaluation keeps the
	// fingerprint but not the audit; binding the request's base commit to the
	// audited one makes the approval refuse once the live commit moves.
	if (approved.approval.publishedCommit !== input.summary.publishedCommit) {
		const error =
			'The package was published again since its security audit, so it was left for the owner. Audit the new version, then try again.'
		await audit('failure', {
			approvalId: approved.approval.id,
			pinnedCommit: approved.approval.publishedCommit,
			error,
		})
		return { ok: false, error }
	}
	// Enqueue reuses a pending owner-path request for the same commit, so the
	// one pending request (or the caller's) is marked in place, and unmarked
	// again on any failure: it stays pending for the owner either way, and an
	// owner Approve never reads as self-publish.
	let requestId = input.pendingRequestId
	let marked = false
	if (!requestId) {
		const enqueued = await enqueueWentPublicApproval({
			env,
			ownerUserId: input.ownerUserId,
			savedPackage,
			publishedCommit: approved.approval.publishedCommit,
			fingerprint,
			requestedByUserId: input.actorUserId,
			selfPublish: true,
		})
		requestId = enqueued.id
		marked = isSelfPublishRequest(enqueued)
	}
	if (!marked && !(await setSelfPublishMark(env, requestId, true))) {
		const error =
			'The request to make this package internet-visible was resolved meanwhile, so nothing was approved.'
		await audit('failure', { requestId, error })
		return { ok: false, error }
	}
	let result: Awaited<ReturnType<typeof approveWentPublicRequest>>
	try {
		result = await approveWentPublicRequest({
			env,
			request: new Request(input.requestUrl),
			savedPackage,
			ownerUserId: input.ownerUserId,
			actorUserId: input.actorUserId,
			requestId,
		})
	} catch (error) {
		await setSelfPublishMark(env, requestId, false)
		throw error
	}
	if (!result.ok) await setSelfPublishMark(env, requestId, false)
	await audit(
		result.ok ? 'success' : 'failure',
		result.ok
			? { requestId, approvalId: approved.approval.id }
			: { requestId, error: result.error },
	)
	return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** Self-publish approves for the owner, so it takes publish permission. */
async function mayPublishPackage(
	ctx: { env: Env; request: RequestContext | null },
	pkg: SavedPackageRecord,
) {
	try {
		await authorizePackageWrite(
			ctx,
			{ id: pkg.id, userId: pkg.userId, label: pkg.name },
			'package:publish',
		)
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}

/**
 * When the owner already approved the current capability set, refresh the pin
 * and approve went_public so internet-visible turns on without another Approve
 * click. Used by packageUpdate and the settings toggle.
 */
export async function applyMatchingPinInternetVisible(input: {
	env: Env
	requestUrl: string
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	fingerprint: string
}): Promise<SelfPublishResult> {
	const pinned = await approvePackageCapabilitySet({
		env: input.env,
		ownerUserId: input.ownerUserId,
		actorUserId: input.actorUserId,
		savedPackage: input.savedPackage,
		requestUrl: input.requestUrl,
		expectedFingerprint: input.fingerprint,
	})
	const requestId =
		pinned.wentPublicRequest?.id ??
		(
			await getPendingWentPublicApproval({
				env: input.env,
				ownerUserId: input.ownerUserId,
				packageId: input.savedPackage.id,
			})
		)?.id
	if (!requestId) {
		return {
			ok: false,
			error:
				'Could not record the request to make this package internet-visible.',
		}
	}
	const applied = await approveWentPublicRequest({
		env: input.env,
		request: new Request(input.requestUrl),
		savedPackage: input.savedPackage,
		ownerUserId: input.ownerUserId,
		actorUserId: input.actorUserId,
		requestId,
	})
	return applied.ok ? { ok: true } : { ok: false, error: applied.error }
}

export type SelfPublishAttempt =
	| { status: 'self_published' }
	| {
			status: 'blocked'
			blocker: SelfPublishBlocker
			reasons: Array<SelfPublishBlockerReason>
			detail: SelfPublishBlockerDetail
	  }
	| { status: 'failed'; error: string }

/**
 * Evaluates and, when eligible and the caller may publish the package,
 * self-publishes it. Nothing is written when it is blocked.
 */
export async function attemptSelfPublish(input: {
	env: Env
	request: RequestContext
	requestUrl: string
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	summary: CapabilityApprovalSummary
	pendingRequestId?: string
	approvalUrl?: string
}): Promise<SelfPublishAttempt> {
	const eligibility = await evaluateSelfPublish(input)
	if (!eligibility.eligible) {
		const detail = buildSelfPublishBlockerDetail({
			blocker: eligibility.blocker,
			reasons: eligibility.reasons,
			approvalUrl: input.approvalUrl,
		})
		return {
			status: 'blocked',
			blocker: eligibility.blocker,
			reasons: eligibility.reasons,
			detail,
		}
	}
	if (
		!(await mayPublishPackage(
			{ env: input.env, request: input.request },
			input.savedPackage,
		))
	) {
		const detail = buildSelfPublishBlockerDetail({
			blocker: 'not_permitted',
			reasons: [{ kind: 'not_permitted' }],
			approvalUrl: input.approvalUrl,
		})
		return {
			status: 'blocked',
			blocker: 'not_permitted',
			reasons: [{ kind: 'not_permitted' }],
			detail,
		}
	}
	const result = await selfPublishPackage(input)
	return result.ok
		? { status: 'self_published' }
		: { status: 'failed', error: result.error }
}
