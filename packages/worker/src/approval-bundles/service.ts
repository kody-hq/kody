/**
 * Approval bundles: an agent gathers pending approvals it can see into one
 * page for the person it acts for. Creating a bundle grants nothing; every
 * decision is the signed-in person's, made in the browser through each
 * item's own approval code (`#app/approval-bundle-decisions.ts`).
 */
import { listPendingCredentialProposals } from '#worker/credentials/agent-credential-proposals.ts'
import {
	orgAuditWriterFromRequest,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { listPendingPackageApprovalRequestsForOwner } from '#worker/package-capabilities/approval-requests-repo.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import {
	approvalBundleCreatedVia,
	approvalBundleMaxItems,
	approvalBundlePath,
	approvalBundleTtlMs,
	approvalItemKey,
	groupApprovalItems,
	parseApprovalItemKey,
	type ApprovalLinkView,
	type ApprovalItemRef,
	type ApprovalItemType,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'
import { loadApprovalItemView, type ApprovalViewer } from './item-views.ts'
import {
	getApprovalBundleForPerson,
	listApprovalBundleDecisions,
	planApprovalBundleInsert,
	type ApprovalBundleDecisionRecord,
	type ApprovalBundleRecord,
} from './repo.ts'

export class ApprovalBundleError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ApprovalBundleError'
	}
}

export type PendingApprovalFilter = {
	types?: ReadonlyArray<ApprovalItemType>
	/** Package ids or kody ids; empty or omitted means every package. */
	packages?: ReadonlyArray<string>
}

const itemViewConcurrency = 8

/**
 * Capability items each compute a full capability summary, so views load a few
 * at a time to keep a large bundle inside Worker subrequest limits.
 */
async function loadItemViews(
	viewer: ApprovalViewer,
	refs: ReadonlyArray<ApprovalItemRef>,
	decisions?: ReadonlyMap<string, ApprovalBundleDecisionRecord>,
): Promise<Array<ApprovalItemView>> {
	const views: Array<ApprovalItemView> = []
	for (let start = 0; start < refs.length; start += itemViewConcurrency) {
		views.push(
			...(await Promise.all(
				refs
					.slice(start, start + itemViewConcurrency)
					.map((ref) =>
						loadApprovalItemView(
							viewer,
							ref,
							decisions?.get(approvalItemKey(ref)) ?? null,
						),
					),
			)),
		)
	}
	return views
}

function wants(filter: PendingApprovalFilter, type: ApprovalItemType) {
	return !filter.types || filter.types.length === 0
		? true
		: filter.types.includes(type)
}

async function candidateRefs(
	viewer: ApprovalViewer,
	filter: PendingApprovalFilter,
): Promise<Array<ApprovalItemRef>> {
	const { env, request } = viewer
	const refs: Array<ApprovalItemRef> = []
	if (wants(filter, 'publish')) {
		const requests = await listPendingPackageApprovalRequestsForOwner(
			env.APP_DB,
			{ ownerUserId: request.org.id },
		)
		refs.push(
			...requests.map((entry) => ({
				type: 'publish' as const,
				requestId: entry.id,
			})),
		)
	}
	if (wants(filter, 'capabilities')) {
		const packages = await listSavedPackagesByUserId(env.APP_DB, {
			userId: request.org.id,
		})
		refs.push(
			...packages
				.filter(
					(savedPackage) =>
						savedPackage.isInternetVisible &&
						namesPackage(filter.packages, savedPackage),
				)
				.map((savedPackage) => ({
					type: 'capabilities' as const,
					packageId: savedPackage.id,
				})),
		)
	}
	const personId = request.actor?.userId
	if (wants(filter, 'credential-picks') && personId) {
		const proposals = await listPendingCredentialProposals({
			db: env.APP_DB,
			orgId: request.org.id,
			personId,
		})
		refs.push(
			...proposals.map((proposal) => ({
				type: 'credential-picks' as const,
				proposalId: proposal.id,
			})),
		)
	}
	return refs
}

function namesPackage(
	packages: ReadonlyArray<string> | undefined,
	savedPackage: { id: string; kodyId: string } | null,
) {
	if (!packages || packages.length === 0) return true
	if (!savedPackage) return false
	return (
		packages.includes(savedPackage.id) || packages.includes(savedPackage.kodyId)
	)
}

/** Every approval waiting on the viewer that they can decide, grouped in order. */
export async function listPendingApprovalItems(
	viewer: ApprovalViewer,
	filter: PendingApprovalFilter = {},
): Promise<Array<ApprovalItemView>> {
	const views = await loadItemViews(viewer, await candidateRefs(viewer, filter))
	return views.filter(
		(item) =>
			item.status === 'pending' && namesPackage(filter.packages, item.package),
	)
}

export type CreatedApprovalBundle = {
	bundle: ApprovalBundleRecord
	url: string
	items: Array<ApprovalItemView>
	/** Requested items left out because nothing waits on the viewer there. */
	skipped: Array<string>
}

function uniqueRefs(refs: ReadonlyArray<ApprovalItemRef>) {
	const seen = new Set<string>()
	return refs.filter((ref) => {
		const key = approvalItemKey(ref)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/**
 * Records a bundle for the viewer from `items`, or from everything pending
 * that matches `filter` when `items` is omitted. Items that are not pending
 * for the viewer are skipped (and reported) rather than stored.
 */
export async function createApprovalBundle(input: {
	viewer: ApprovalViewer
	items?: ReadonlyArray<ApprovalItemRef>
	filter?: PendingApprovalFilter
	note?: string | null
}): Promise<CreatedApprovalBundle> {
	const { viewer } = input
	const personId = viewer.request.actor?.userId
	const orgSlug = viewer.request.org.slug
	if (!personId || !orgSlug) {
		throw new ApprovalBundleError(
			'Approval bundles need a signed-in person in an org with a handle.',
		)
	}
	let items: Array<ApprovalItemView>
	let skipped: Array<string> = []
	if (input.items) {
		const refs = uniqueRefs(input.items)
		if (refs.length > approvalBundleMaxItems) {
			throw new ApprovalBundleError(
				`A bundle holds at most ${approvalBundleMaxItems} items; got ${refs.length}.`,
			)
		}
		const views = await loadItemViews(viewer, refs)
		items = views.filter((item) => item.status === 'pending')
		skipped = views
			.filter((item) => item.status !== 'pending')
			.map((item) => item.key)
	} else {
		items = await listPendingApprovalItems(viewer, input.filter)
		if (items.length > approvalBundleMaxItems) {
			throw new ApprovalBundleError(
				`${items.length} approvals are pending, more than the ${approvalBundleMaxItems} a bundle holds. Narrow by package or type.`,
			)
		}
	}
	if (items.length === 0) {
		throw new ApprovalBundleError(
			skipped.length > 0
				? `None of the requested items is waiting on you: ${skipped.join(', ')}.`
				: 'Nothing is waiting on you to approve.',
		)
	}
	const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null
	const { record, statement } = planApprovalBundleInsert(viewer.env.APP_DB, {
		orgId: viewer.request.org.id,
		personUserId: personId,
		agentCredentialKind: viewer.request.credential.kind,
		agentCredentialId: viewer.request.credential.id,
		note,
		items: items.flatMap((item) => {
			const ref = parseApprovalItemKey(item.key)
			return ref ? [ref] : []
		}),
	})
	await runAppDbBatchWithOrgAudit({
		appDb: viewer.env.APP_DB,
		audit: orgAuditWriterFromRequest(viewer.env, viewer.request),
		statements: [statement],
		event: {
			orgId: viewer.request.org.id,
			action: 'approval.bundle.create',
			resourceType: 'approval_bundle',
			resourceId: record.id,
			targetUserId: personId,
			details: {
				items: items.map((item) => item.key),
				skipped,
			},
		},
	})
	return {
		bundle: record,
		url: new URL(
			approvalBundlePath({ orgSlug, bundleId: record.id }),
			viewer.baseUrl,
		).toString(),
		items,
		skipped,
	}
}

export function approvalBundleExpiresAt(bundle: ApprovalBundleRecord) {
	return new Date(Date.parse(bundle.createdAt) + approvalBundleTtlMs)
}

/** The bundle as the viewer sees it now; only the person it was made for can open it. */
/**
 * Open an approval link id for the viewer. Agents share both bundle ids and
 * credential proposal ids under `/-/approvals/`, so an id that is no bundle
 * may still be a live proposal the viewer can decide.
 */
export async function loadApprovalBundleView(input: {
	viewer: ApprovalViewer
	bundleId: string
	now?: Date
}): Promise<ApprovalLinkView> {
	const { viewer } = input
	const personId = viewer.request.actor?.userId
	if (!personId) return { ok: false, reason: 'unavailable' }
	const bundle = await getApprovalBundleForPerson(viewer.env.APP_DB, {
		id: input.bundleId,
		orgId: viewer.request.org.id,
		personUserId: personId,
	})
	if (!bundle) return await loadProposalLink(viewer, input.bundleId)
	const expiresAt = approvalBundleExpiresAt(bundle)
	if (expiresAt.getTime() <= (input.now ?? new Date()).getTime()) {
		return { ok: false, reason: 'expired' }
	}
	const decisions = await listApprovalBundleDecisions(
		viewer.env.APP_DB,
		bundle.id,
	)
	const items = await loadItemViews(viewer, bundle.items, decisions)
	return {
		ok: true,
		view: {
			ok: true,
			bundle: {
				id: bundle.id,
				orgSlug: viewer.request.org.slug ?? '',
				createdAt: bundle.createdAt,
				expiresAt: expiresAt.toISOString(),
				note: bundle.note,
				createdVia: approvalBundleCreatedVia(bundle.agentCredentialKind),
			},
			groups: groupApprovalItems(items),
		},
	}
}

async function loadProposalLink(
	viewer: ApprovalViewer,
	proposalId: string,
): Promise<ApprovalLinkView> {
	const item = await loadApprovalItemView(viewer, {
		type: 'credential-picks',
		proposalId,
	})
	return item.status === 'pending' && item.reviewHref
		? { ok: false, reason: 'proposal', href: item.reviewHref }
		: { ok: false, reason: 'unavailable' }
}
