/**
 * What each approval bundle item grants, in plain language, as one person
 * sees it. Reads only: approving lives in `#app/approval-bundle-decisions.ts`,
 * which calls each item's own approval code. Items a viewer cannot decide
 * come back `unavailable` without saying why, so a bundle never leaks which
 * packages exist.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { getRecordedCredentialProposal } from '#worker/credentials/agent-credential-proposals.ts'
import {
	listUsableCredentials,
	resolveNeedCandidates,
	type UsableCredential,
} from '#worker/credentials/credential-candidates.ts'
import { resolveCredentialApproval } from '#worker/credentials/credential-approval.ts'
import {
	readCredentialNeedChanges,
	type CredentialNeedChange,
} from '#worker/credentials/credential-needs-approval.ts'
import { loadPackageMappingScopeForRequest } from '#worker/credentials/package-mapping-scope-access.ts'
import {
	getPackageApprovalRequestForOwner,
	type PackageApprovalRequest,
} from '#worker/package-capabilities/approval-requests-repo.ts'
import { loadCapabilityApprovalSummary } from '#worker/package-capabilities/capability-approval-service.ts'
import { loadCurrentPackageSecurityAudit } from '#worker/package-capabilities/security-audit-state.ts'
import { type CapabilitySetEntry } from '#worker/package-capabilities/capability-set.ts'
import { readWentPublicSummary } from '#worker/package-capabilities/went-public-approval.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import {
	savedCredentialNeeds,
	type SavedCredentialNeed,
} from '#worker/credentials/credential-needs.ts'
import {
	approvalItemKey,
	type ApprovalGrantLine,
	type ApprovalItemPackage,
	type ApprovalItemRef,
	type ApprovalItemSecurityAudit,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'
import {
	buildCredentialApprovalHref,
	type CredentialApprovalChangeView,
	type CredentialKind,
	type CredentialMappingTarget,
} from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import {
	approvalAfterLabel,
	approvalBeforeLabel,
	approvalProblems,
} from '#universal/package-credential-approval-page.ts'
import { describeTrigger } from '#universal/package-credentials-page.ts'
import { routes } from '#universal/routes.ts'
import { type ApprovalBundleDecisionRecord } from './repo.ts'

/** The person reviewing, bound to the org the bundle is for. */
export type ApprovalViewer = {
	env: Env
	baseUrl: string
	request: RequestContext
}

type ViewerCache = {
	usableByPackage: Map<string, Promise<Array<UsableCredential>>>
}

const caches = new WeakMap<ApprovalViewer, ViewerCache>()

function cacheFor(viewer: ApprovalViewer) {
	let cache = caches.get(viewer)
	if (!cache) {
		cache = { usableByPackage: new Map() }
		caches.set(viewer, cache)
	}
	return cache
}

function usableCredentials(viewer: ApprovalViewer, packageId: string) {
	const cache = cacheFor(viewer)
	const existing = cache.usableByPackage.get(packageId)
	if (existing) return existing
	const next = listUsableCredentials({
		env: viewer.env,
		request: viewer.request,
		packageId,
	})
	cache.usableByPackage.set(packageId, next)
	return next
}

function orgSlug(viewer: ApprovalViewer) {
	return viewer.request.org.slug ?? ''
}

function packageView(
	viewer: ApprovalViewer,
	savedPackage: SavedPackageRecord,
): ApprovalItemPackage {
	return {
		id: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		href: routes.communityPackage.href({
			username: orgSlug(viewer),
			kodyId: savedPackage.kodyId,
		}),
	}
}

/**
 * The package when the viewer may manage it (`package:write`). Same bar as the
 * approve-capabilities page. Callers that need `package:publish` to decide
 * still check that for `canApprove`; write-only agents (typical API tokens)
 * must still see went_public rows that the page shows.
 */
async function loadPublishablePackage(
	viewer: ApprovalViewer,
	packageId: string,
): Promise<SavedPackageRecord | null> {
	const savedPackage = await getSavedPackageById(viewer.env.APP_DB, {
		userId: viewer.request.org.id,
		packageId,
	})
	if (!savedPackage) return null
	const access = await computeEffectivePermissions({
		env: viewer.env,
		request: viewer.request,
	})
	const allowed = checkPermission(
		access,
		'package:write',
		packageResource({
			id: savedPackage.id,
			userId: savedPackage.userId,
			label: savedPackage.kodyId,
		}),
	).allowed
	return allowed ? savedPackage : null
}

/** Whether the viewer may approve publish / went_public items. */
async function viewerCanApprovePublish(
	viewer: ApprovalViewer,
	savedPackage: SavedPackageRecord,
) {
	const access = await computeEffectivePermissions({
		env: viewer.env,
		request: viewer.request,
	})
	return checkPermission(
		access,
		'package:publish',
		packageResource({
			id: savedPackage.id,
			userId: savedPackage.userId,
			label: savedPackage.kodyId,
		}),
	).allowed
}

function unavailable(
	ref: ApprovalItemRef,
	decision: ApprovalBundleDecisionRecord | null,
): ApprovalItemView {
	return {
		key: approvalItemKey(ref),
		type: ref.type,
		title: 'No longer available',
		summary:
			'This item was removed, or you can no longer approve it in this organization.',
		package: null,
		status: 'unavailable',
		statusMessage: null,
		canApprove: false,
		canDeny: false,
		fingerprint: null,
		detailLabel: null,
		grants: [],
		reviewHref: null,
		decision: decisionView(decision),
	}
}

function decisionView(decision: ApprovalBundleDecisionRecord | null) {
	return decision
		? { decision: decision.decision, decidedAt: decision.decidedAt }
		: null
}

/**
 * A recorded decision closes the item for this bundle, even when the item
 * changes later; later changes belong in a new bundle.
 */
function decidedState(
	decision: ApprovalBundleDecisionRecord | null,
): Pick<
	ApprovalItemView,
	'status' | 'statusMessage' | 'canApprove' | 'canDeny'
> | null {
	if (!decision) return null
	return {
		status: decision.decision,
		statusMessage: null,
		canApprove: false,
		canDeny: false,
	}
}

function kindLabel(kind: string | null | undefined) {
	if (!kind) return null
	switch (kind) {
		case 'secret':
		case 'oauth':
		case 'mcp':
		case 'url':
		case 'login':
		case 'signing':
			return credentialKindLabel(kind)
		default:
			return kind
	}
}

function describeNeedShape(shape: {
	kind?: string
	provider: string
	multiple: boolean
}) {
	const kind = kindLabel(shape.kind) ?? 'Any fetch-capable kind'
	return `${kind} from provider "${shape.provider}"${shape.multiple ? ', several allowed' : ''}`
}

function candidateHosts(candidates: ReadonlyArray<UsableCredential>) {
	return [...new Set(candidates.flatMap((credential) => credential.hosts))]
}

function describeMatch(resolution: {
	status: 'ready' | 'ambiguous' | 'unbound' | 'expired'
	autoPick: UsableCredential | null
	candidates: ReadonlyArray<UsableCredential>
}) {
	if (resolution.status === 'ready' && resolution.autoPick) {
		return `Uses ${resolution.autoPick.name}.`
	}
	if (resolution.status === 'expired') {
		const named =
			resolution.autoPick?.name ??
			resolution.candidates.map((credential) => credential.name).join(', ')
		if (!named) {
			return 'A matching credential is expired; runs will not fill it until it is refreshed.'
		}
		return `${named} matches but is expired; runs will not fill it until it is refreshed.`
	}
	if (resolution.candidates.length === 0) {
		return 'No credential of yours matches yet; runs fail until you add one.'
	}
	if (resolution.candidates.length === 1) {
		const only = resolution.candidates[0]!
		if (only.expired) {
			return `${only.name} matches but is expired; runs will not fill it until it is refreshed.`
		}
		return `Uses ${only.name}.`
	}
	return `${resolution.candidates.length} of your credentials match (${resolution.candidates
		.map((credential) => credential.name)
		.join(', ')}); runs need a mapping to pick one.`
}

async function credentialNeedGrant(
	viewer: ApprovalViewer,
	change: CredentialNeedChange,
	packageId: string,
): Promise<ApprovalGrantLine> {
	const usable = await usableCredentials(viewer, packageId)
	const after = change.after
	const resolution = resolveNeedCandidates(
		{
			key: change.key,
			kind: after.kind,
			provider: after.provider,
		},
		usable,
	)
	const matched = resolution.autoPick
		? [resolution.autoPick]
		: resolution.candidates
	return {
		change: change.change,
		label: change.key,
		where: change.from ? `Declared by ${change.from}` : null,
		kind: kindLabel(after.kind),
		provider: after.provider,
		hosts: candidateHosts(matched),
		before: describeNeedBefore(change),
		after: describeNeedShape(after),
		match: describeMatch(resolution),
	}
}

function describeNeedBefore(change: CredentialNeedChange) {
	switch (change.change) {
		case 'added':
			return null
		case 'changed':
			return describeNeedShape(change.before)
		default: {
			const exhaustive: never = change
			throw new Error(
				`Unknown credential need change: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

async function publishItemView(
	viewer: ApprovalViewer,
	ref: Extract<ApprovalItemRef, { type: 'publish' }>,
	decision: ApprovalBundleDecisionRecord | null,
): Promise<ApprovalItemView> {
	const request = await getPackageApprovalRequestForOwner(viewer.env.APP_DB, {
		id: ref.requestId,
		ownerUserId: viewer.request.org.id,
	})
	if (!request) return unavailable(ref, decision)
	const savedPackage = await loadPublishablePackage(viewer, request.packageId)
	if (!savedPackage) return unavailable(ref, decision)
	const source = await getEntitySourceById(
		viewer.env.APP_DB,
		savedPackage.sourceId,
	)
	const publishedCommit =
		source?.user_id === viewer.request.org.id
			? (source.published_commit ?? null)
			: null
	const base = {
		key: approvalItemKey(ref),
		type: ref.type,
		package: packageView(viewer, savedPackage),
		fingerprint: request.pendingCommit,
		reviewHref: routes.communityPackageApproveCapabilities.href({
			username: orgSlug(viewer),
			kodyId: savedPackage.kodyId,
		}),
		decision: decisionView(decision),
	}
	const state = publishItemState(request, publishedCommit, decision)
	const mayPublish = await viewerCanApprovePublish(viewer, savedPackage)
	const publishState =
		state.status === 'pending' && !mayPublish
			? {
					...state,
					canApprove: false,
					canDeny: false,
					statusMessage:
						state.statusMessage ??
						'You can review this on the package’s approval page; deciding needs package:publish.',
				}
			: state
	switch (request.reason) {
		case 'credential_needs_changed': {
			const changes = readCredentialNeedChanges(request.details)
			return {
				...base,
				...publishState,
				detailLabel: 'Paused commit',
				title: 'Publish with changed credential needs',
				summary:
					'Approving publishes this version, which asks for the credentials below. The previously published version keeps serving until you approve. Denying drops this paused publish.',
				grants: await Promise.all(
					changes.map((change) =>
						credentialNeedGrant(viewer, change, savedPackage.id),
					),
				),
			}
		}
		case 'went_public': {
			const needLines = await wentPublicNeedLines(viewer, savedPackage)
			return {
				...base,
				...(publishState.canApprove && needLines === null
					? {
							...publishState,
							canApprove: false,
							statusMessage:
								'Kody could not load the credentials this app asks for. Try again before approving.',
						}
					: publishState.canApprove &&
						  !(await wentPublicCapabilitiesApproved(viewer, savedPackage))
						? {
								...publishState,
								canApprove: false,
								statusMessage:
									'Its credentials and capabilities are not approved yet. Review them on the package’s approval page, where one Approve also turns on internet-visible serving.',
							}
						: publishState),
				detailLabel: 'Published commit',
				title: 'Serve on the public internet',
				summary: `${readWentPublicSummary(request.details)} Approving turns on internet-visible serving for this version. Denying leaves it off.`,
				grants: [
					{
						change: 'added',
						label: 'Public internet',
						where: null,
						kind: null,
						provider: null,
						hosts: [],
						before: 'Not internet-visible',
						after: 'Anyone on the internet can reach this package’s app',
						match: null,
					},
					...(needLines ?? []),
				],
			}
		}
		default: {
			const exhaustive: never = request.reason
			throw new Error(`Unknown approval reason: ${String(exhaustive)}`)
		}
	}
}

/** The published credential needs a public app asks for, by who supplies them. */
async function wentPublicNeedLines(
	viewer: ApprovalViewer,
	savedPackage: SavedPackageRecord,
): Promise<Array<ApprovalGrantLine> | null> {
	try {
		const needs = savedCredentialNeeds(
			await loadPublishedCredentialNeeds({
				env: viewer.env,
				userId: viewer.request.org.id,
				sourceId: savedPackage.sourceId,
				request: viewer.request,
			}),
		)
		return needs.map((need) => ({
			change: 'added' as const,
			label: need.key,
			where: need.from ? `Declared by ${need.from}` : null,
			kind: kindLabel(need.kind),
			provider: need.provider,
			hosts: [],
			before: null,
			after: `${describeNeedShape(need)}. ${describeNeedSupplier(need)}`,
			match: null,
		}))
	} catch (error) {
		console.error('Failed to load credential needs for went_public item:', {
			packageId: savedPackage.id,
			error: getErrorMessage(error),
		})
		return null
	}
}

function describeNeedSupplier(need: SavedCredentialNeed) {
	if (need.supplier === 'executor') {
		return need.required === false
			? 'Each visitor may choose their own credential (optional).'
			: 'Each visitor must choose their own credential (required).'
	}
	if (need.supplier === 'publisher' || need.ownerCredentialForVisitors) {
		return 'Supplied by the publisher; visitors use it through the app.'
	}
	return 'Resolved for whoever runs it: their own mapping, the org’s mapping, or a matching credential.'
}

/** Going public needs the live capability set approved first. */
async function wentPublicCapabilitiesApproved(
	viewer: ApprovalViewer,
	savedPackage: SavedPackageRecord,
) {
	try {
		const summary = await loadCapabilityApprovalSummary({
			env: viewer.env,
			ownerUserId: viewer.request.org.id as OwnerId,
			savedPackage,
			requestUrl: viewer.baseUrl,
		})
		return summary.fingerprintMatchesApproval
	} catch (error) {
		// One unreadable package must not break the bundle; it can still be denied.
		console.error('Failed to load capability summary for went_public item:', {
			packageId: savedPackage.id,
			error: getErrorMessage(error),
		})
		return false
	}
}

function publishItemState(
	request: PackageApprovalRequest,
	publishedCommit: string | null,
	decision: ApprovalBundleDecisionRecord | null,
): Pick<
	ApprovalItemView,
	'status' | 'statusMessage' | 'canApprove' | 'canDeny'
> {
	const decided = decidedState(decision)
	if (decided) return decided
	const closed = { canApprove: false, canDeny: false }
	switch (request.status) {
		case 'approved':
			return { ...closed, status: 'approved', statusMessage: null }
		case 'superseded':
			return {
				...closed,
				status: 'resolved',
				statusMessage:
					'A later publish replaced this request, or it was turned down.',
			}
		case 'pending':
			if (request.baseCommit !== publishedCommit) {
				return {
					...closed,
					status: 'resolved',
					statusMessage:
						'The published version changed since this publish paused. Publish again to ask for approval.',
				}
			}
			return {
				status: 'pending',
				statusMessage: null,
				canApprove: true,
				canDeny: true,
			}
		default: {
			const exhaustive: never = request.status
			throw new Error(`Unknown approval status: ${String(exhaustive)}`)
		}
	}
}

function capabilityKey(entry: CapabilitySetEntry) {
	return entry.kind === 'credential'
		? `credential:${entry.credentialId ?? entry.name ?? ''}`
		: `storage:${entry.storageId ?? ''}`
}

function readApprovedEntries(json: string | null): Array<CapabilitySetEntry> {
	if (!json) return []
	try {
		const parsed: unknown = JSON.parse(json)
		return Array.isArray(parsed) ? (parsed as Array<CapabilitySetEntry>) : []
	} catch {
		return []
	}
}

function describeCapabilityEntry(entry: CapabilitySetEntry) {
	if (entry.kind === 'storage') return 'Package storage'
	const hosts =
		entry.hosts.length > 0 ? entry.hosts.join(', ') : 'no hosts listed'
	return `${kindLabel(entry.credentialKind ?? 'secret')} sent to ${hosts}${entry.placement ? ` (${entry.placement})` : ''}`
}

function capabilityEntrySignature(entry: CapabilitySetEntry) {
	return JSON.stringify([
		entry.kind,
		entry.credentialId ?? null,
		entry.credentialKind ?? 'secret',
		entry.hosts.map((host) => host.toLowerCase()).sort(),
		entry.placement ?? null,
		entry.storageId ?? null,
		entry.via,
	])
}

function describeCapabilityChange(
	entry: CapabilitySetEntry,
	other: CapabilitySetEntry | null,
) {
	const description = describeCapabilityEntry(entry)
	if (!other || description !== describeCapabilityEntry(other)) {
		return description
	}
	return entry.via.length > 0
		? `${description}, reached via ${entry.via.join(' → ')}`
		: `${description}, used directly by this package`
}

export function capabilityGrantLines(
	before: ReadonlyArray<CapabilitySetEntry>,
	after: ReadonlyArray<CapabilitySetEntry>,
): Array<ApprovalGrantLine> {
	const previous = new Map(before.map((entry) => [capabilityKey(entry), entry]))
	const current = new Map(after.map((entry) => [capabilityKey(entry), entry]))
	const line = (
		change: ApprovalGrantLine['change'],
		entry: CapabilitySetEntry,
		prior: CapabilitySetEntry | null,
	): ApprovalGrantLine => ({
		change,
		label:
			entry.kind === 'storage'
				? 'Storage'
				: (entry.name ?? entry.credentialId ?? 'Credential'),
		where: entry.via.length > 1 ? `Reached via ${entry.via.join(' → ')}` : null,
		kind: entry.kind === 'storage' ? null : kindLabel(entry.credentialKind),
		provider: null,
		hosts: entry.hosts,
		before: prior
			? describeCapabilityChange(prior, change === 'changed' ? entry : null)
			: null,
		after: change === 'removed' ? null : describeCapabilityChange(entry, prior),
		match: null,
	})
	const lines: Array<ApprovalGrantLine> = []
	for (const [key, entry] of current) {
		const prior = previous.get(key) ?? null
		if (!prior) {
			lines.push(line('added', entry, null))
		} else if (
			capabilityEntrySignature(prior) !== capabilityEntrySignature(entry)
		) {
			lines.push(line('changed', entry, prior))
		}
	}
	for (const [key, entry] of previous) {
		if (!current.has(key)) lines.push(line('removed', entry, entry))
	}
	return lines
}

async function capabilitiesSecurityAudit(
	viewer: ApprovalViewer,
	input: {
		packageId: string
		publishedCommit: string | null
		fingerprint: string
	},
): Promise<ApprovalItemSecurityAudit | null> {
	if (!input.publishedCommit) return null
	const audit = await loadCurrentPackageSecurityAudit(viewer.env.APP_DB, {
		ownerUserId: viewer.request.org.id,
		packageId: input.packageId,
		publishedCommit: input.publishedCommit,
		fingerprint: input.fingerprint,
	})
	return audit
		? {
				status: 'audited',
				verdict: audit.verdict,
				auditor: audit.auditor,
				recordedAt: audit.recordedAt,
			}
		: { status: 'not_audited' }
}

async function capabilitiesItemView(
	viewer: ApprovalViewer,
	ref: Extract<ApprovalItemRef, { type: 'capabilities' }>,
	decision: ApprovalBundleDecisionRecord | null,
): Promise<ApprovalItemView> {
	const savedPackage = await loadPublishablePackage(viewer, ref.packageId)
	if (!savedPackage) return unavailable(ref, decision)
	const summary = await loadCapabilityApprovalSummary({
		env: viewer.env,
		ownerUserId: viewer.request.org.id as OwnerId,
		savedPackage,
		requestUrl: viewer.baseUrl,
	})
	const grants = capabilityGrantLines(
		readApprovedEntries(summary.latestApproval?.capabilitySetJson ?? null),
		summary.capabilitySet.entries,
	)
	const securityAudit = await capabilitiesSecurityAudit(viewer, {
		packageId: savedPackage.id,
		publishedCommit: summary.publishedCommit,
		fingerprint: summary.capabilitySet.fingerprint,
	})
	const base = {
		key: approvalItemKey(ref),
		type: ref.type,
		title: 'Approve changed internet-visible capabilities',
		summary:
			'This internet-visible package now reaches different credentials or storage than you approved. Approving pins the current set for public serving. Denying leaves it unapproved.',
		package: packageView(viewer, savedPackage),
		fingerprint: summary.capabilitySet.fingerprint,
		detailLabel: 'Capability fingerprint',
		grants,
		reviewHref: routes.communityPackageApproveCapabilities.href({
			username: orgSlug(viewer),
			kodyId: savedPackage.kodyId,
		}),
		...(securityAudit ? { securityAudit } : {}),
		decision: decisionView(decision),
	}
	const decided = decidedState(decision)
	if (decided) return { ...base, ...decided }
	const closed = { canApprove: false, canDeny: false }
	if (summary.fingerprintMatchesApproval) {
		return {
			...base,
			...closed,
			status: 'resolved',
			statusMessage: 'This capability set is approved.',
		}
	}
	if (!summary.isInternetVisible || !summary.publishedCommit) {
		return {
			...base,
			...closed,
			status: 'resolved',
			statusMessage:
				'This package is not internet-visible, so there is nothing to approve here. Use its approval page to make it internet-visible.',
		}
	}
	return {
		...base,
		grants:
			grants.length > 0
				? grants
				: [
						{
							change: 'changed',
							label: 'Capability set',
							where: null,
							kind: null,
							provider: null,
							hosts: [],
							before: summary.latestApproval
								? 'A different capability set'
								: 'Nothing approved yet',
							after:
								'The current set differs in details this page cannot show. Open its approval page to review every entry.',
							match: null,
						},
					],
		status: 'pending',
		statusMessage: null,
		canApprove: true,
		canDeny: true,
	}
}

function mappingWhere(target: CredentialMappingTarget) {
	switch (target.type) {
		case 'default':
			return target.layer === 'org' ? 'Org default' : 'Your default'
		case 'trigger':
			return describeTrigger(target.trigger)
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown mapping target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

function pickGrant(
	change: CredentialApprovalChangeView,
	hostsById: ReadonlyMap<string, Array<string>>,
): ApprovalGrantLine {
	return {
		change: change.before === null ? 'added' : 'changed',
		label: change.needKey,
		where: mappingWhere(change.target),
		kind: change.need?.kind
			? credentialKindLabel(change.need.kind as CredentialKind)
			: null,
		provider: change.need?.provider ?? null,
		hosts: [
			...new Set(change.after.flatMap((ref) => hostsById.get(ref.id) ?? [])),
		],
		before: approvalBeforeLabel(change),
		after: approvalAfterLabel(change),
		match: change.error
			? change.error.message
			: change.willEnable && change.target.type === 'trigger'
				? `Approving turns on ${describeTrigger(change.target.trigger)} for you.`
				: null,
	}
}

async function credentialPicksItemView(
	viewer: ApprovalViewer,
	ref: Extract<ApprovalItemRef, { type: 'credential-picks' }>,
	decision: ApprovalBundleDecisionRecord | null,
): Promise<ApprovalItemView> {
	const personId = viewer.request.actor?.userId
	if (!personId) return unavailable(ref, decision)
	const recorded = await getRecordedCredentialProposal({
		db: viewer.env.APP_DB,
		id: ref.proposalId,
		orgId: viewer.request.org.id,
		personId,
	})
	if (!recorded) return unavailable(ref, decision)
	const scope = await loadPackageMappingScopeForRequest({
		env: viewer.env,
		baseUrl: viewer.baseUrl,
		request: viewer.request,
		packageIdOrKodyId: recorded.packageId,
	})
	if (!scope) return unavailable(ref, decision)
	const { view } = await resolveCredentialApproval(scope, recorded.proposal)
	const hostsById = new Map(
		scope.usable.map((credential) => [credential.id, credential.hosts]),
	)
	const grants = [
		...view.changes.map((change) => pickGrant(change, hostsById)),
		...view.enable.map((entry): ApprovalGrantLine => ({
			change: 'added',
			label: describeTrigger(entry.trigger),
			where: 'Turn on',
			kind: null,
			provider: null,
			hosts: [],
			before: entry.willEnable ? 'Off for you' : 'Already on for you',
			after: 'On for you',
			match: entry.error?.message ?? null,
		})),
	]
	const problems = approvalProblems(view)
	const reason = recorded.proposal.reason
	const base = {
		key: approvalItemKey(ref),
		type: ref.type,
		title: 'Choose credentials',
		summary: `Approving saves these credential mappings for ${scope.savedPackage.kodyId} and turns on any trigger listed. Denying changes nothing.${reason ? ` Agent note (not written by Kody): ${reason}` : ''}`,
		package: packageView(viewer, scope.savedPackage),
		fingerprint: view.fingerprint,
		detailLabel: 'Approval fingerprint',
		grants,
		reviewHref: buildCredentialApprovalHref({
			username: orgSlug(viewer),
			kodyId: scope.savedPackage.kodyId,
			changes: recorded.proposal.changes,
			enable: recorded.proposal.enable,
			reason: recorded.proposal.reason,
			sender: recorded.proposal.sender,
			proposalId: recorded.id,
		}),
		decision: decisionView(decision),
	}
	const decided = decidedState(decision)
	if (decided) return { ...base, ...decided }
	const closed = { canApprove: false, canDeny: false }
	if (recorded.approvedAt) {
		return { ...base, ...closed, status: 'approved', statusMessage: null }
	}
	return {
		...base,
		status: 'pending',
		statusMessage:
			problems.length > 0
				? `Fix before approving: ${problems.join(' ')}`
				: null,
		canApprove: view.canApprove,
		canDeny: true,
	}
}

export async function loadApprovalItemView(
	viewer: ApprovalViewer,
	ref: ApprovalItemRef,
	decision: ApprovalBundleDecisionRecord | null = null,
): Promise<ApprovalItemView> {
	switch (ref.type) {
		case 'publish':
			return publishItemView(viewer, ref, decision)
		case 'capabilities':
			return capabilitiesItemView(viewer, ref, decision)
		case 'credential-picks':
			return credentialPicksItemView(viewer, ref, decision)
		default: {
			const exhaustive: never = ref
			throw new Error(`Unknown approval item: ${JSON.stringify(exhaustive)}`)
		}
	}
}
