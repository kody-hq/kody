/**
 * Approval bundles (`/@:orgSlug/-/approvals/:bundleId`): one page an agent
 * prefills with pending approvals across packages. The person reviews each
 * item and approves all of them at once, or approves or denies each one.
 * Agents only create bundles (`approvalBundleCreate`); nothing here approves.
 * Shapes are shared by the page, its JSON API, and the MCP capabilities.
 * Nothing here carries a credential value.
 */

export const approvalItemTypes = [
	'publish',
	'capabilities',
	'credential-picks',
] as const

/**
 * - `publish`: a paused publish (`package_approval_requests`: credential needs
 *   changed, or the package going public).
 * - `capabilities`: an internet-visible package whose capability set changed
 *   since it was approved.
 * - `credential-picks`: a recorded `credentialMappingPropose` proposal
 *   (default mappings and trigger credential picks).
 */
export type ApprovalItemType = (typeof approvalItemTypes)[number]

export type ApprovalItemRef =
	| { type: 'publish'; requestId: string }
	| { type: 'capabilities'; packageId: string }
	| { type: 'credential-picks'; proposalId: string }

/** At most this many items in one bundle. */
export const approvalBundleMaxItems = 100

/** Bundles stop opening after this long. */
export const approvalBundleTtlMs = 30 * 24 * 60 * 60 * 1000

function approvalItemRefId(ref: ApprovalItemRef): string {
	switch (ref.type) {
		case 'publish':
			return ref.requestId
		case 'capabilities':
			return ref.packageId
		case 'credential-picks':
			return ref.proposalId
		default: {
			const exhaustive: never = ref
			throw new Error(`Unknown approval item: ${JSON.stringify(exhaustive)}`)
		}
	}
}

/** `publish:<requestId>`, `capabilities:<packageId>`, or `credential-picks:<proposalId>`. */
export function approvalItemKey(ref: ApprovalItemRef): string {
	return `${ref.type}:${approvalItemRefId(ref)}`
}

export function parseApprovalItemKey(key: string): ApprovalItemRef | null {
	const colon = key.indexOf(':')
	if (colon <= 0) return null
	const type = key.slice(0, colon)
	const id = key.slice(colon + 1).trim()
	if (!id) return null
	switch (type) {
		case 'publish':
			return { type, requestId: id }
		case 'capabilities':
			return { type, packageId: id }
		case 'credential-picks':
			return { type, proposalId: id }
		default:
			return null
	}
}

/** One thing an item grants or changes, in plain language. */
export type ApprovalGrantLine = {
	change: 'added' | 'changed' | 'removed'
	/** The need key, credential name, or surface (such as "Public internet"). */
	label: string
	/** Where it applies: a mapping layer, a trigger, or the dependency that declared a need. */
	where: string | null
	/** Credential kind label (Key, OAuth, ...); null when any fetch-capable kind fits. */
	kind: string | null
	provider: string | null
	/** Hosts the credential can reach. */
	hosts: Array<string>
	/** What was approved before; null when nothing was. */
	before: string | null
	after: string | null
	/** Which of the person's credentials this resolves to, when that helps. */
	match: string | null
}

/**
 * - `pending`: waiting for a decision.
 * - `approved` / `denied`: decided (here or elsewhere for `approved`).
 * - `resolved`: no longer needs a decision (replaced by a later publish,
 *   already approved elsewhere, or no longer internet-visible).
 * - `unavailable`: gone, or not yours to decide.
 */
export type ApprovalItemStatus =
	| 'pending'
	| 'approved'
	| 'denied'
	| 'resolved'
	| 'unavailable'

export type ApprovalItemPackage = {
	id: string
	kodyId: string
	name: string
	href: string
}

export type ApprovalItemSecurityAudit =
	| { status: 'not_audited' }
	| {
			status: 'audited'
			verdict: 'pass' | 'concerns'
			auditor: string
			recordedAt: string
	  }

export type ApprovalItemView = {
	key: string
	type: ApprovalItemType
	/** Short heading, such as "Publish with changed credential needs". */
	title: string
	/** One plain-language sentence saying what approving does. */
	summary: string
	package: ApprovalItemPackage | null
	status: ApprovalItemStatus
	/** Why the item is not pending, or what blocks approving it. */
	statusMessage: string | null
	canApprove: boolean
	canDeny: boolean
	/** Pins what was reviewed; a decision sends it back. */
	fingerprint: string | null
	/**
	 * Human label for the fingerprint in Details (paused commit, published
	 * commit, capability fingerprint, or approval fingerprint).
	 */
	detailLabel: string | null
	grants: Array<ApprovalGrantLine>
	/** The item's own approval page. */
	reviewHref: string | null
	/**
	 * Capability items only: the informational security audit for the current
	 * published commit + capability set. It never approves anything.
	 */
	securityAudit?: ApprovalItemSecurityAudit
	decision: {
		decision: 'approved' | 'denied'
		decidedAt: string
	} | null
}

export type ApprovalBundlePackageGroup = {
	package: ApprovalItemPackage | null
	items: Array<ApprovalItemView>
}

export type ApprovalBundleView = {
	ok: true
	bundle: {
		id: string
		orgSlug: string
		createdAt: string
		expiresAt: string
		/** Untrusted note from the agent that made the bundle. */
		note: string | null
		/** How the agent connected: an MCP client, the CLI, or an API token. */
		createdVia: string | null
	}
	groups: Array<ApprovalBundlePackageGroup>
}

export type ApprovalBundleLoaderData =
	| { ok: true; view: ApprovalBundleView }
	| { ok: false; reason: 'not-found' | 'expired' }

export type ApprovalBundleDecisionRequest = {
	action: 'approve' | 'deny'
	item: string
	fingerprint: string
}

export type ApprovalBundleDecisionResponse =
	| { ok: true; item: ApprovalItemView }
	| { ok: false; error: string; item: ApprovalItemView | null }

export function approvalBundlePath(input: {
	orgSlug: string
	bundleId: string
}) {
	return `/@${encodeURIComponent(input.orgSlug)}/-/approvals/${encodeURIComponent(input.bundleId)}`
}

/** Groups items by package, in the order each package first appears. */
export function groupApprovalItems(
	items: ReadonlyArray<ApprovalItemView>,
): Array<ApprovalBundlePackageGroup> {
	const groups = new Map<string, ApprovalBundlePackageGroup>()
	for (const item of items) {
		const key = item.package?.id ?? `unavailable:${item.key}`
		const group = groups.get(key) ?? { package: item.package, items: [] }
		group.items.push(item)
		groups.set(key, group)
	}
	return [...groups.values()]
}

/** Items still waiting on a decision, including ones that cannot be approved yet. */
export function approvalItemsAwaitingDecision(
	view: Pick<ApprovalBundleView, 'groups'>,
): Array<ApprovalItemView> {
	return view.groups.flatMap((group) =>
		group.items.filter((item) => item.status === 'pending'),
	)
}

/** Pending items Approve all can approve right now. */
export function approvalItemsReadyToApprove(
	view: Pick<ApprovalBundleView, 'groups'>,
): Array<ApprovalItemView> {
	return approvalItemsAwaitingDecision(view).filter((item) => item.canApprove)
}

export function approvalItemStatusLabel(status: ApprovalItemStatus) {
	switch (status) {
		case 'pending':
			return 'Waiting for you'
		case 'approved':
			return 'Approved'
		case 'denied':
			return 'Denied'
		case 'resolved':
			return 'Nothing to decide'
		case 'unavailable':
			return 'Unavailable'
		default: {
			const exhaustive: never = status
			throw new Error(`Unknown approval status: ${String(exhaustive)}`)
		}
	}
}

export function approveAllLabel(ready: number, waiting: number = ready) {
	if (ready === 0) {
		return waiting === 0
			? 'Nothing left to approve'
			: 'Nothing here can be approved yet'
	}
	return ready === 1 ? 'Approve 1 change' : `Approve all ${ready} changes`
}

export function approvalBundleCreatedVia(kind: string | null) {
	switch (kind) {
		case 'mcp-oauth':
			return 'an MCP client'
		case 'cli':
			return 'the Kody CLI'
		case 'api-token':
			return 'an API token'
		default:
			return null
	}
}

/** One line per item, for agents that read text. */
export function describeApprovalItem(item: ApprovalItemView) {
	const where = item.package ? ` (${item.package.name})` : ''
	const grants = item.grants.map((grant) => {
		const parts = [
			grant.kind,
			grant.provider ? `provider ${grant.provider}` : null,
			grant.hosts.length > 0 ? `hosts ${grant.hosts.join(', ')}` : null,
		].filter(Boolean)
		const detail = parts.length > 0 ? ` [${parts.join('; ')}]` : ''
		const diff =
			grant.before && grant.after
				? `: ${grant.before} -> ${grant.after}`
				: grant.after
					? `: ${grant.after}`
					: grant.before
						? `: was ${grant.before}`
						: ''
		return `${grant.change} ${grant.label}${detail}${diff}`
	})
	return `${item.title}${where}: ${item.summary}${grants.length > 0 ? ` ${grants.join('; ')}.` : ''}`
}
