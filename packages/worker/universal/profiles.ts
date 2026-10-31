/**
 * Website view of profiles (ADR 0092): page payload types and the pure tree
 * logic behind the Agent profiles page. The capabilities stay the authority;
 * these helpers only decide what the page offers.
 */

/** Same cap as `maxProfileDepth` in `src/profiles/rules.ts`. */
export const profileTreeMaxDepth = 5

export type ProfileStatus = 'active' | 'expired' | 'revoked' | 'parent_inactive'

type ProfileGrantItem = {
	resourceType: string
	resourceId: string
	permissions: Array<string>
	/** Display name when Kody could resolve the resource, else null. */
	label: string | null
	/** Page for the resource when it has one. */
	href: string | null
}

export type ProfileItem = {
	id: string
	name: string
	parentProfileId: string | null
	actingUserId: string
	/** Username of the person the profile acts for, when known. */
	actingHandle: string | null
	depth: number
	status: ProfileStatus
	expiresAt: string | null
	effectiveExpiresAt: string | null
	revokedAt: string | null
	createdAt: string
	/** Root first, this profile last. */
	chain: Array<{ id: string; name: string }>
	grants: Array<ProfileGrantItem>
}

export type ProfileTokenItem = {
	id: string
	name: string
	profileId: string
	status: 'active' | 'expired' | 'revoked'
	scopes: Array<string>
	expiresAt: string
	maxExpiresAt: string
	lastUsedAt: string | null
	createdAt: string
}

export type ProfilesViewer = {
	userId: string
	username: string
	isOwner: boolean
}

export type ProfilesPageData =
	| { enabled: false; orgSlug: string }
	| {
			enabled: true
			orgSlug: string
			orgId: string
			personalOrg: boolean
			viewer: ProfilesViewer
			/** Owner listing every member's profiles (`all_members: true`). */
			allMembers: boolean
			profiles: Array<ProfileItem>
			tokens: Array<ProfileTokenItem>
			/**
			 * Grants the viewer may hand a new top-level profile, as resources
			 * they can pick. Sub-profiles pick from their parent's grants.
			 */
			grantOptions: Array<ProfileGrantOption>
			/** `profileList` refused (e.g. no `profile:manage`): its message. */
			listError: string | null
	  }

export type ProfileGrantOption = {
	resourceType: string
	resourceId: string
	label: string
	permissions: Array<string>
}

export type ProfileTreeNode = {
	profile: ProfileItem
	/** 1-based level in the visible tree (equals `depth` unless detached). */
	level: number
	/** The parent is not in this list (another person's, or purged). */
	detached: boolean
	children: Array<ProfileTreeNode>
}

const statusOrder: Record<ProfileStatus, number> = {
	active: 0,
	parent_inactive: 1,
	expired: 2,
	revoked: 3,
}

function compareProfiles(a: ProfileItem, b: ProfileItem) {
	return (
		statusOrder[a.status] - statusOrder[b.status] ||
		a.name.localeCompare(b.name) ||
		a.id.localeCompare(b.id)
	)
}

/**
 * Nest a flat `profileList` result into roots and sub-profiles. A profile
 * whose parent is not in the list becomes a detached root, so nothing the
 * capability returned is hidden.
 */
export function buildProfileTree(
	profiles: ReadonlyArray<ProfileItem>,
): Array<ProfileTreeNode> {
	const byId = new Map(profiles.map((profile) => [profile.id, profile]))
	const childrenOf = new Map<string, Array<ProfileItem>>()
	const roots: Array<ProfileItem> = []
	for (const profile of profiles) {
		const parentId = profile.parentProfileId
		if (parentId && byId.has(parentId) && parentId !== profile.id) {
			const list = childrenOf.get(parentId) ?? []
			list.push(profile)
			childrenOf.set(parentId, list)
		} else {
			roots.push(profile)
		}
	}
	const seen = new Set<string>()
	function node(profile: ProfileItem, level: number): ProfileTreeNode {
		seen.add(profile.id)
		const children = (childrenOf.get(profile.id) ?? [])
			.filter((child) => !seen.has(child.id))
			.sort(compareProfiles)
			.map((child) => node(child, level + 1))
		return {
			profile,
			level,
			detached: profile.parentProfileId !== null && level === 1,
			children,
		}
	}
	const tree = roots.sort(compareProfiles).map((root) => node(root, 1))
	// A parent cycle cannot come from the store, but never drop a profile.
	for (const profile of [...profiles].sort(compareProfiles)) {
		if (!seen.has(profile.id)) tree.push(node(profile, 1))
	}
	return tree
}

/** Depth-first ids of rows a tree shows, skipping collapsed subtrees. */
export function visibleTreeIds(
	tree: ReadonlyArray<ProfileTreeNode>,
	collapsed: ReadonlySet<string>,
): Array<string> {
	const ids: Array<string> = []
	const walk = (nodes: ReadonlyArray<ProfileTreeNode>) => {
		for (const entry of nodes) {
			ids.push(entry.profile.id)
			if (!collapsed.has(entry.profile.id)) walk(entry.children)
		}
	}
	walk(tree)
	return ids
}

export function findTreeNode(
	tree: ReadonlyArray<ProfileTreeNode>,
	id: string,
): ProfileTreeNode | null {
	for (const entry of tree) {
		if (entry.profile.id === id) return entry
		const found = findTreeNode(entry.children, id)
		if (found) return found
	}
	return null
}

/** Every profile below this node, nearest first. */
export function descendantCount(node: ProfileTreeNode): number {
	return node.children.reduce(
		(total, child) => total + 1 + descendantCount(child),
		0,
	)
}

export function profileStatusLabel(status: ProfileStatus) {
	switch (status) {
		case 'active':
			return 'Active'
		case 'expired':
			return 'Expired'
		case 'revoked':
			return 'Revoked'
		case 'parent_inactive':
			return 'Parent inactive'
	}
}

export function profileStatusExplanation(status: ProfileStatus) {
	switch (status) {
		case 'active':
			return 'Requests made as this profile work.'
		case 'expired':
			return 'This profile passed its expiry and no longer works.'
		case 'revoked':
			return 'This profile was revoked. Revoke is final.'
		case 'parent_inactive':
			return 'A profile above this one is revoked or expired, so this one stops working too.'
	}
}

/** The person controls their own profiles; Owners only list and revoke. */
export function canEditProfile(profile: ProfileItem, viewer: ProfilesViewer) {
	return profile.actingUserId === viewer.userId && profile.status === 'active'
}

export function canRevokeProfile(profile: ProfileItem, viewer: ProfilesViewer) {
	if (profile.status === 'revoked') return false
	return profile.actingUserId === viewer.userId || viewer.isOwner
}

export type SubProfileBlock = 'not_yours' | 'inactive' | 'depth' | null

/** Why a sub-profile cannot go under this parent, or null when it can. */
export function subProfileBlock(
	profile: ProfileItem,
	viewer: ProfilesViewer,
): SubProfileBlock {
	if (profile.actingUserId !== viewer.userId) return 'not_yours'
	if (profile.status !== 'active') return 'inactive'
	if (profile.depth >= profileTreeMaxDepth) return 'depth'
	return null
}

export function subProfileBlockMessage(block: Exclude<SubProfileBlock, null>) {
	switch (block) {
		case 'not_yours':
			return 'Only the person this profile acts for can add sub-profiles to it.'
		case 'inactive':
			return 'Only an active profile can get sub-profiles.'
		case 'depth':
			return `Profiles nest at most ${profileTreeMaxDepth} levels deep, and this one is at level ${profileTreeMaxDepth}.`
	}
}

/** Tokens bound to one profile, live ones first. */
export function tokensForProfile(
	tokens: ReadonlyArray<ProfileTokenItem>,
	profileId: string,
) {
	return tokens
		.filter((token) => token.profileId === profileId)
		.sort(
			(a, b) =>
				Number(b.status === 'active') - Number(a.status === 'active') ||
				b.createdAt.localeCompare(a.createdAt),
		)
}

/**
 * Expiry only moves earlier (`profile_expiry_extension`). Returns an error
 * message for a value the server would refuse, or null.
 */
export function expiryChangeProblem(input: {
	current: string | null
	/** Earliest expiry across the parents, when there are parents. */
	parentLimit?: string | null
	next: string
	now?: Date
}): string | null {
	const next = Date.parse(input.next)
	if (Number.isNaN(next)) return 'Pick a valid date and time.'
	if (next <= (input.now ?? new Date()).getTime())
		return 'Pick a time in the future.'
	if (input.current && next > Date.parse(input.current))
		return 'Expiry can only move earlier. Create a new profile for more time.'
	if (input.parentLimit && next > Date.parse(input.parentLimit))
		return 'A sub-profile cannot outlive its parents.'
	return null
}

/** Grants a sub-profile may pick: what every profile in its parent chain still holds. */
export function subProfileGrantOptions(
	parent: ProfileItem,
	profiles: ReadonlyArray<ProfileItem>,
): Array<ProfileGrantOption> {
	const byId = new Map(profiles.map((profile) => [profile.id, profile]))
	const chain = parent.chain.map((entry) =>
		entry.id === parent.id ? parent : byId.get(entry.id),
	)
	if (chain.some((profile) => !profile)) return []
	return parent.grants.flatMap((grant) => {
		const permissions = grant.permissions.filter((permission) =>
			chain.every((profile) =>
				profile!.grants.some(
					(held) =>
						held.resourceType === grant.resourceType &&
						held.resourceId === grant.resourceId &&
						held.permissions.includes(permission),
				),
			),
		)
		return permissions.length
			? [
					{
						resourceType: grant.resourceType,
						resourceId: grant.resourceId,
						label: grant.label ?? grant.resourceId,
						permissions,
					},
				]
			: []
	})
}

/** CLI / MCP equivalents shown on the page so agents can do the same. */
export function profileAgentHints(input: {
	orgSlug: string
	personalOrg: boolean
	profileId?: string
}) {
	const org = input.personalOrg ? '' : ` --org ${input.orgSlug}`
	const id = input.profileId ?? 'prf_...'
	return {
		mcp: [
			`profileList({})`,
			`profileCreate({ name: "my-agent", grants: [] })`,
			`profileCreate({ name: "helper", parent_profile_id: "${id}" })`,
			`tokenCreate({ name: "my-agent", profile_id: "${id}", scopes: ["org:execute"], lifetime: "short" })`,
			`profileRevoke({ profile_id: "${id}" })`,
		],
		cli: [
			`npx @kodycodes/cli api profileList${org}`,
			`npx @kodycodes/cli api tokenCreate${org} --params '{"name":"my-agent","profile_id":"${id}","scopes":["org:execute"],"lifetime":"short"}'`,
		],
	}
}
