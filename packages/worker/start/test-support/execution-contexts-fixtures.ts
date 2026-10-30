import {
	type ExecutionChain,
	type ExecutionContextListItem,
	type ExecutionContextsPageData,
} from '#universal/execution-contexts.ts'

export function contextFixture(
	overrides: Partial<ExecutionContextListItem> = {},
): ExecutionContextListItem {
	return {
		id: 'ec_laptop',
		name: 'my-laptop',
		ownerOrg: { id: 'org_jane', slug: 'jane' },
		operator: { handle: 'jane' },
		isOperator: true,
		myPermissions: ['read', 'execute', 'write', 'delete', 'manage_access'],
		sharing: {
			level: 'only_me',
			grants: [],
			attachedOrgs: [],
			allMembers: false,
		},
		status: 'online',
		acceptingRuns: true,
		lastSeenAt: '2026-01-02T03:04:05.000Z',
		revokedAt: null,
		client: { name: '@kodycodes/cli', version: '1.40.0' },
		capabilities: { os: 'darwin', maxConcurrent: 2, features: ['fs'] },
		grantSummary: {
			fs: 1,
			fsMode: 'read',
			egress: { mode: 'public' },
			runtime: 'all',
			timeoutMs: 90_000,
		},
		optedIn: false,
		usable: true,
		chainUsage: { inMyChain: false, chainCount: 0 },
		...overrides,
	}
}

export const sharedBuildbox = contextFixture({
	id: 'ec_buildbox',
	name: 'buildbox',
	operator: { handle: 'sam' },
	ownerOrg: { id: 'org_jane', slug: 'jane' },
	isOperator: false,
	myPermissions: ['read', 'execute'],
	sharing: undefined,
	grantSummary: {
		fs: 0,
		egress: { mode: 'public-and-lan' },
		runtime: { mode: 'allowlist', count: 2 },
		timeoutMs: 300_000,
	},
	canOptIn: true,
	chainUsage: { inMyChain: false, chainCount: 2 },
})

const offlineServer = contextFixture({
	id: 'ec_server',
	name: 'home-server',
	status: 'offline',
	acceptingRuns: false,
	chainUsage: { inMyChain: true, chainCount: 1 },
})

export function chainFixture(
	entries: ExecutionChain['entries'] = [{ kind: 'cloud' }],
): ExecutionChain {
	return { entries, strict: false, updatedAt: null, updatedBy: null }
}

export function pageFixture(
	overrides: Partial<
		Extract<ExecutionContextsPageData, { enabled: true }>
	> = {},
): Extract<ExecutionContextsPageData, { enabled: true }> {
	return {
		enabled: true,
		orgSlug: 'jane',
		personalOrg: true,
		teams: [],
		attachableOrgs: [],
		contexts: [contextFixture(), sharedBuildbox, offlineServer],
		chain: chainFixture([
			{ kind: 'context', id: 'ec_server', usable: true },
			{ kind: 'cloud' },
		]),
		unutilized: {
			count: 2,
			contexts: [
				{ id: 'ec_buildbox', name: 'buildbox', needsOptIn: true },
				{ id: 'ec_laptop', name: 'my-laptop', needsOptIn: false },
			],
			note: '2 registered execution contexts are not in your chain: buildbox (needs opt-in), my-laptop.',
		},
		selected: null,
		selectedMissing: false,
		...overrides,
	}
}
