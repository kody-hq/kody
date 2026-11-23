/**
 * Decisions on approval bundle items. Each approve runs the item's own
 * approval code (the same calls its per-package page makes), so approving
 * from a bundle is the same as approving the item where it lives. A denial
 * changes nothing except superseding a paused publish. Every decision is
 * recorded once per bundle item and audited.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	approveCredentialNeedsRequest,
	approveWentPublicRequest,
} from '#app/account-package-approval-requests.ts'
import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import {
	loadApprovalItemView,
	type ApprovalViewer,
} from '#worker/approval-bundles/item-views.ts'
import {
	claimApprovalBundleDecision,
	finalizeApprovalBundleDecisionStatement,
	getApprovalBundleForPerson,
	listApprovalBundleDecisions,
	releaseApprovalBundleDecision,
	type ApprovalBundleRecord,
} from '#worker/approval-bundles/repo.ts'
import { approvalBundleExpiresAt } from '#worker/approval-bundles/service.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { approveCredentialProposal } from '#worker/credentials/credential-approval.ts'
import { getRecordedCredentialProposal } from '#worker/credentials/agent-credential-proposals.ts'
import { loadPackageMappingScopeForRequest } from '#worker/credentials/package-mapping-scope-access.ts'
import {
	logOrgAuditEvent,
	orgAuditWriterFromRequest,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import {
	getPackageApprovalRequestForOwner,
	resolvePackageApprovalRequest,
} from '#worker/package-capabilities/approval-requests-repo.ts'
import {
	approvePackageCapabilitySet,
	CapabilityApprovalError,
} from '#worker/package-capabilities/capability-approval-service.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	approvalBundleApproveConcurrency,
	approvalItemKey,
	parseApprovalItemKey,
	type ApprovalBundleApproveAllEvent,
	type ApprovalBundleDecisionRequest,
	type ApprovalBundleDecisionResponse,
	type ApprovalItemRef,
	type ApprovalItemType,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'

/** The signed-in person bound to the org named by `orgSlug`; null when not a member. */
export async function loadApprovalViewerForSlug(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
}): Promise<ApprovalViewer | null> {
	const binding = await loadOrgBindingForSlug(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		input.orgSlug,
	)
	if (!binding) return null
	return {
		env: input.env,
		baseUrl: getAppBaseUrl({ env: input.env, requestUrl: input.request.url }),
		request: deriveRequestContext({
			user: input.user.mcpUser,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	}
}

type DecisionResult =
	| { ok: true; status: 200; body: ApprovalBundleDecisionResponse }
	| {
			ok: false
			status: 400 | 404 | 409
			body: ApprovalBundleDecisionResponse
	  }

type ApproveOutcome = { ok: true } | { ok: false; error: string }

function failure(
	status: 400 | 404 | 409,
	error: string,
	item: ApprovalItemView | null,
): DecisionResult {
	return { ok: false, status, body: { ok: false, error, item } }
}

async function approveItem(input: {
	viewer: ApprovalViewer
	request: Request
	user: AuthenticatedAppUser
	ref: ApprovalItemRef
	fingerprint: string
}): Promise<ApproveOutcome> {
	const { viewer, ref } = input
	const notFound = { ok: false as const, error: 'This item is not available.' }
	switch (ref.type) {
		case 'publish': {
			const approval = await getPackageApprovalRequestForOwner(
				viewer.env.APP_DB,
				{ id: ref.requestId, ownerUserId: viewer.request.org.id },
			)
			if (!approval) return notFound
			const writable = await loadWritableAccountSavedPackage({
				env: viewer.env,
				user: input.user,
				packageId: approval.packageId,
				permission: 'package:publish',
			})
			if (
				!writable.ok ||
				writable.package.ownerUserId !== viewer.request.org.id
			) {
				return notFound
			}
			const args = {
				env: viewer.env,
				request: input.request,
				savedPackage: writable.package.savedPackage,
				ownerUserId: writable.package.ownerUserId,
				actorUserId: writable.package.actorUserId,
				requestId: approval.id,
			}
			switch (approval.reason) {
				case 'credential_needs_changed': {
					const result = await approveCredentialNeedsRequest(args)
					return result.ok ? result : { ok: false, error: result.error }
				}
				case 'went_public': {
					const result = await approveWentPublicRequest(args)
					return result.ok ? result : { ok: false, error: result.error }
				}
				default: {
					const exhaustive: never = approval.reason
					throw new Error(`Unknown approval reason: ${String(exhaustive)}`)
				}
			}
		}
		case 'capabilities': {
			const writable = await loadWritableAccountSavedPackage({
				env: viewer.env,
				user: input.user,
				packageId: ref.packageId,
				permission: 'package:publish',
			})
			if (
				!writable.ok ||
				writable.package.ownerUserId !== viewer.request.org.id
			) {
				return notFound
			}
			try {
				await approvePackageCapabilitySet({
					env: viewer.env,
					ownerUserId: writable.package.ownerUserId,
					actorUserId: writable.package.actorUserId,
					savedPackage: writable.package.savedPackage,
					requestUrl: input.request.url,
					expectedFingerprint: input.fingerprint,
					recordPin: true,
				})
				return { ok: true }
			} catch (error) {
				if (error instanceof CapabilityApprovalError) {
					return { ok: false, error: error.message }
				}
				throw error
			}
		}
		case 'credential-picks': {
			const personId = viewer.request.actor?.userId
			if (!personId) return notFound
			const recorded = await getRecordedCredentialProposal({
				db: viewer.env.APP_DB,
				id: ref.proposalId,
				orgId: viewer.request.org.id,
				personId,
			})
			if (!recorded) return notFound
			const scope = await loadPackageMappingScopeForRequest({
				env: viewer.env,
				baseUrl: viewer.baseUrl,
				request: viewer.request,
				packageIdOrKodyId: recorded.packageId,
			})
			if (!scope) return notFound
			const outcome = await approveCredentialProposal({
				scope,
				proposal: recorded.proposal,
				fingerprint: input.fingerprint,
				proposalId: recorded.id,
			})
			switch (outcome.status) {
				case 'approved':
					return { ok: true }
				case 'invalid':
					return {
						ok: false,
						error: 'This proposal has errors to fix before it can be approved.',
					}
				case 'stale':
					return {
						ok: false,
						error:
							'Credentials or mappings changed since you reviewed this item. Review the updated changes and approve again.',
					}
				case 'conflict':
					return { ok: false, error: outcome.message }
				default: {
					const exhaustive: never = outcome
					throw new Error(`Unhandled approval outcome: ${String(exhaustive)}`)
				}
			}
		}
		default: {
			const exhaustive: never = ref
			throw new Error(`Unknown approval item: ${JSON.stringify(exhaustive)}`)
		}
	}
}

/** Denying a paused publish drops it; other denials leave everything as is. */
async function denyItem(input: {
	viewer: ApprovalViewer
	user: AuthenticatedAppUser
	ref: ApprovalItemRef
}): Promise<ApproveOutcome> {
	const { viewer, ref } = input
	const notFound = { ok: false as const, error: 'This item is not available.' }
	switch (ref.type) {
		case 'publish': {
			const approval = await getPackageApprovalRequestForOwner(
				viewer.env.APP_DB,
				{ id: ref.requestId, ownerUserId: viewer.request.org.id },
			)
			if (!approval) return notFound
			const writable = await loadWritableAccountSavedPackage({
				env: viewer.env,
				user: input.user,
				packageId: approval.packageId,
				permission: 'package:publish',
			})
			if (
				!writable.ok ||
				writable.package.ownerUserId !== viewer.request.org.id
			) {
				return notFound
			}
			const superseded = await resolvePackageApprovalRequest(
				viewer.env.APP_DB,
				{
					id: ref.requestId,
					status: 'superseded',
					resolvedByUserId: viewer.request.actor?.userId ?? null,
				},
			)
			return superseded
				? { ok: true }
				: {
						ok: false,
						error:
							'This publish was already approved or replaced, so there is nothing to deny.',
					}
		}
		case 'capabilities':
		case 'credential-picks':
			return { ok: true }
		default: {
			const exhaustive: never = ref
			throw new Error(`Unknown approval item: ${JSON.stringify(exhaustive)}`)
		}
	}
}

function auditDetails(
	bundle: ApprovalBundleRecord,
	item: ApprovalItemView,
	extra: Record<string, unknown> = {},
) {
	return {
		bundleId: bundle.id,
		item: item.key,
		type: item.type,
		packageId: item.package?.id ?? null,
		packageKodyId: item.package?.kodyId ?? null,
		fingerprint: item.fingerprint,
		...extra,
	}
}

async function auditFailure(input: {
	viewer: ApprovalViewer
	bundle: ApprovalBundleRecord
	item: ApprovalItemView
	action: 'approve' | 'deny'
	error: string
}) {
	const { viewer } = input
	await logOrgAuditEvent({
		env: viewer.env,
		orgId: viewer.request.org.id,
		action: `approval.bundle.${input.action}`,
		result: 'failure',
		actorUserId: viewer.request.actor?.userId ?? null,
		actorUsername: viewer.request.actor?.username ?? null,
		credentialKind: viewer.request.credential.kind,
		credentialId: viewer.request.credential.id,
		resourceType: 'approval_bundle',
		resourceId: input.bundle.id,
		details: auditDetails(input.bundle, input.item, { error: input.error }),
	}).catch((error: unknown) => {
		console.error('Failed to audit approval bundle failure:', {
			bundleId: input.bundle.id,
			item: input.item.key,
			error: getErrorMessage(error),
		})
	})
}

/**
 * Approves or denies one item in a bundle. `fingerprint` must match what the
 * person reviewed, so a change after the page loaded asks them to look again.
 */
export async function decideApprovalBundleItem(input: {
	viewer: ApprovalViewer
	request: Request
	user: AuthenticatedAppUser
	bundleId: string
	decision: ApprovalBundleDecisionRequest
}): Promise<DecisionResult> {
	const { viewer } = input
	const personId = viewer.request.actor?.userId
	if (!personId) return failure(404, 'Approval bundle not found.', null)
	const bundle = await getApprovalBundleForPerson(viewer.env.APP_DB, {
		id: input.bundleId,
		orgId: viewer.request.org.id,
		personUserId: personId,
	})
	if (!bundle) return failure(404, 'Approval bundle not found.', null)
	if (approvalBundleExpiresAt(bundle).getTime() <= Date.now()) {
		return failure(
			409,
			'This approval bundle expired. Ask your agent for a new one.',
			null,
		)
	}
	const ref = parseApprovalItemKey(input.decision.item)
	if (
		!ref ||
		!bundle.items.some(
			(entry) => approvalItemKey(entry) === input.decision.item,
		)
	) {
		return failure(404, 'That item is not in this bundle.', null)
	}
	const itemKey = approvalItemKey(ref)
	const decisions = await listApprovalBundleDecisions(
		viewer.env.APP_DB,
		bundle.id,
	)
	const existing = decisions.get(itemKey) ?? null
	const current = await loadApprovalItemView(viewer, ref, existing)
	if (existing) {
		return failure(409, 'This item was already decided.', current)
	}
	const approving = input.decision.action === 'approve'
	if (approving ? !current.canApprove : !current.canDeny) {
		return failure(
			409,
			current.statusMessage ??
				(approving
					? 'This item cannot be approved right now.'
					: 'This item cannot be denied right now.'),
			current,
		)
	}
	if (current.fingerprint !== input.decision.fingerprint) {
		return failure(
			409,
			'This item changed since the page loaded. Review the updated item and decide again.',
			current,
		)
	}
	const decision = approving ? 'approved' : 'denied'
	const claim = {
		bundleId: bundle.id,
		itemKey,
		decision,
		decidedByUserId: personId,
		decidedAt: new Date().toISOString(),
	} as const
	if (
		!(await claimApprovalBundleDecision(viewer.env.APP_DB, {
			...claim,
			orgId: bundle.orgId,
		}))
	) {
		const latest = await loadCurrentItemView(viewer, bundle.id, ref)
		return failure(
			409,
			latest.decision
				? 'This item was already decided.'
				: 'This item is being decided in another tab. Reload in a moment to see the result.',
			latest,
		)
	}
	let outcome: ApproveOutcome
	try {
		outcome = approving
			? await approveItem({
					viewer,
					request: input.request,
					user: input.user,
					ref,
					fingerprint: input.decision.fingerprint,
				})
			: await denyItem({
					viewer,
					user: input.user,
					ref,
				})
	} catch (error) {
		await releaseApprovalBundleDecision(viewer.env.APP_DB, claim)
		throw error
	}
	if (!outcome.ok) {
		await releaseApprovalBundleDecision(viewer.env.APP_DB, claim)
		await auditFailure({
			viewer,
			bundle,
			item: current,
			action: approving ? 'approve' : 'deny',
			error: outcome.error,
		})
		return failure(
			409,
			outcome.error,
			await loadApprovalItemView(viewer, ref, null),
		)
	}
	const { decidedAt } = claim
	// The approve or deny already happened, so it is audited even when the
	// claim expired mid-way and another request took it over.
	const { changed: finalized } = await runAppDbBatchWithOrgAudit({
		appDb: viewer.env.APP_DB,
		audit: orgAuditWriterFromRequest(viewer.env, viewer.request),
		statements: [
			finalizeApprovalBundleDecisionStatement(
				viewer.env.APP_DB,
				claim,
				new Date().toISOString(),
			),
		],
		event: {
			orgId: viewer.request.org.id,
			action: approving ? 'approval.bundle.approve' : 'approval.bundle.deny',
			resourceType: 'approval_bundle',
			resourceId: bundle.id,
			details: auditDetails(bundle, current),
		},
	})
	return {
		ok: true,
		status: 200,
		body: {
			ok: true,
			item: finalized
				? await loadApprovalItemView(viewer, ref, {
						itemKey,
						decision,
						decidedByUserId: personId,
						decidedAt,
					})
				: await loadCurrentItemView(viewer, bundle.id, ref),
		},
	}
}

async function loadCurrentItemView(
	viewer: ApprovalViewer,
	bundleId: string,
	ref: ApprovalItemRef,
) {
	const decisions = await listApprovalBundleDecisions(
		viewer.env.APP_DB,
		bundleId,
	)
	return loadApprovalItemView(
		viewer,
		ref,
		decisions.get(approvalItemKey(ref)) ?? null,
	)
}

type ApproveAllEntry = { item: string; fingerprint: string }

/**
 * A paused publish moves the published version, which changes what the
 * package's other items pin (its capability set, its credential picks), so
 * those go first and the publish last.
 */
const samePackageOrder: Record<ApprovalItemType, number> = {
	'credential-picks': 0,
	capabilities: 1,
	publish: 2,
}

/**
 * Approve all. Each item runs `decideApprovalBundleItem`, so it does exactly
 * what approving it alone does and is audited the same way. Items on one
 * package run one at a time (credential picks, then capabilities, then the
 * publish), so they never race; packages run in parallel, at most
 * `concurrency` at once. `onEvent` reports each item as it starts and ends.
 */
export async function approveApprovalBundleItems(input: {
	viewer: ApprovalViewer
	request: Request
	user: AuthenticatedAppUser
	bundleId: string
	items: ReadonlyArray<ApproveAllEntry>
	concurrency?: number
	onEvent?: (event: ApprovalBundleApproveAllEvent) => void
}): Promise<Array<{ item: string; result: ApprovalBundleDecisionResponse }>> {
	const { viewer } = input
	const personId = viewer.request.actor?.userId
	const bundle = personId
		? await getApprovalBundleForPerson(viewer.env.APP_DB, {
				id: input.bundleId,
				orgId: viewer.request.org.id,
				personUserId: personId,
			})
		: null
	const position = new Map(
		(bundle?.items ?? []).map((ref, index) => [approvalItemKey(ref), index]),
	)
	const unique = [
		...new Map(input.items.map((entry) => [entry.item, entry])).values(),
	].sort(
		(a, b) =>
			(position.get(a.item) ?? Number.MAX_SAFE_INTEGER) -
			(position.get(b.item) ?? Number.MAX_SAFE_INTEGER),
	)
	const packageKeys = await Promise.all(
		unique.map((entry) => approvalItemPackageKey(viewer, entry.item)),
	)
	const groups = new Map<string, Array<ApproveAllEntry>>()
	for (const [index, entry] of unique.entries()) {
		const key = packageKeys[index]!
		groups.set(key, [...(groups.get(key) ?? []), entry])
	}
	const rank = (entry: ApproveAllEntry) => {
		const ref = parseApprovalItemKey(entry.item)
		return ref ? samePackageOrder[ref.type] : 0
	}
	for (const group of groups.values()) group.sort((a, b) => rank(a) - rank(b))
	const results: Array<{
		item: string
		result: ApprovalBundleDecisionResponse
	}> = []
	const approveOne = async (entry: ApproveAllEntry) => {
		input.onEvent?.({ item: entry.item, phase: 'approving' })
		let result: ApprovalBundleDecisionResponse
		try {
			const decided = await decideApprovalBundleItem({
				viewer,
				request: input.request,
				user: input.user,
				bundleId: input.bundleId,
				decision: { action: 'approve', ...entry },
			})
			result = decided.body
		} catch (error) {
			console.error('Approve all could not finish an item:', {
				bundleId: input.bundleId,
				item: entry.item,
				error: getErrorMessage(error),
			})
			result = {
				ok: false,
				error: 'Kody could not finish this approval. Try again.',
				item: null,
			}
		}
		results.push({ item: entry.item, result })
		input.onEvent?.({ item: entry.item, phase: 'done', result })
	}
	const queue = [...groups.values()]
	const lane = async () => {
		for (let group = queue.shift(); group; group = queue.shift()) {
			for (const entry of group) await approveOne(entry)
		}
	}
	const lanes = Math.min(
		Math.max(1, input.concurrency ?? approvalBundleApproveConcurrency),
		queue.length,
	)
	await Promise.all(Array.from({ length: lanes }, lane))
	return results
}

/**
 * The package an item acts on. Items with no package each get their own key;
 * items whose package could not be read share one lane, so they stay serial.
 */
async function approvalItemPackageKey(viewer: ApprovalViewer, key: string) {
	const ref = parseApprovalItemKey(key)
	if (!ref) return `item:${key}`
	if (ref.type === 'capabilities') return `package:${ref.packageId}`
	try {
		const view = await loadApprovalItemView(viewer, ref, null)
		return view.package ? `package:${view.package.id}` : `item:${key}`
	} catch {
		return 'unknown'
	}
}
