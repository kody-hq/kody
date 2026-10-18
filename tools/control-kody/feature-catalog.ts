export type Feature = {
	id: string
	title: string
	file: string
	paths: Array<string>
	apis: Array<string>
}

export const featuresDirRelativePath = pathToFeaturesDir()

function pathToFeaturesDir() {
	return '.agents/skills/control-kody/references/features'
}

/**
 * User-facing surfaces agents rediscover. Keep `paths` aligned with
 * `packages/worker/start/routeTree.gen.ts` document paths. Only external HTTP protocols and downloads go in
 * `apis`, website reads and mutations use Start server functions.
 */
export const featureCatalog: ReadonlyArray<Feature> = [
	{
		id: 'login',
		title: 'Sign in',
		file: 'login.md',
		paths: ['/login'],
		apis: ['/auth', '/session'],
	},
	{
		id: 'signup',
		title: 'Sign up and email verify',
		file: 'signup.md',
		paths: [
			'/signup',
			'/verify-email',
			'/pending-verification',
			'/verify-email-change',
			'/verify-email-claim-release',
			'/verify-email-destination',
			'/unsubscribe/tips',
		],
		apis: [],
	},
	{
		id: 'onboarding',
		title: 'Onboarding',
		file: 'onboarding.md',
		paths: [
			'/onboarding',
			'/onboarding/step-1',
			'/onboarding/step-1/$agent',
			'/onboarding/step-2',
			'/onboarding/step-2/$service',
			'/onboarding/step-3',
			'/onboarding/step-3/$agent',
		],
		apis: [],
	},
	{
		id: 'password-reset',
		title: 'Password reset',
		file: 'password-reset.md',
		paths: ['/reset-password'],
		apis: [],
	},
	{
		id: 'two-factor',
		title: 'Two-factor auth',
		file: 'two-factor.md',
		paths: ['/account/two-factor', '/verify'],
		apis: [],
	},
	{
		id: 'passkeys',
		title: 'Passkeys',
		file: 'passkeys.md',
		paths: ['/account/passkeys'],
		apis: [],
	},
	{
		id: 'account',
		title: 'Account hub',
		file: 'account.md',
		paths: [
			'/account',
			'/account/security',
			'/account/data',
			'/account/organizations',
			'/account/organizations/new',
			'/@{$orgSlug}/-/overview',
			'/@{$orgSlug}/-/settings',
			'/@{$orgSlug}/-/members',
			'/@{$orgSlug}/-/teams',
			'/@{$orgSlug}/-/grants',
			'/@{$orgSlug}/-/collaborators',
			'/join/$token',
		],
		apis: ['/account/export.json'],
	},
	{
		id: 'connections',
		title: 'Agents (connected agents)',
		file: 'connections.md',
		paths: [
			'/account/agents',
			'/account/connections',
			'/@{$orgSlug}/-/connections',
			'/@{$orgSlug}/-/agents',
		],
		apis: [],
	},
	{
		id: 'packages',
		title: 'Packages',
		file: 'packages.md',
		paths: [
			'/account/packages',
			'/@{$orgSlug}/-/packages',
			'/account/packages/$packageId',
			'/account/packages/$packageId/approve-publish',
			'/account/packages/$packageId/files/$',
			'/@{$username}',
			'/@{$username}/$kodyId',
			'/@{$username}/$kodyId/icon/$iconCommit',
			'/@{$username}/$kodyId/settings',
			'/@{$username}/$kodyId/collaborators',
			'/account/repos/$repoId/icon/$iconCommit',
			'/@{$username}/$kodyId/approve-publish',
			'/@{$orgSlug}/-/repositories',
			'/@{$orgSlug}/-/approvals/$bundleId',
		],
		apis: ['/account/packages.json', '/@{$username}/$kodyId/raw/$ref/$'],
	},
	{
		id: 'secrets',
		title: 'Secrets',
		file: 'secrets.md',
		paths: [
			'/@{$orgSlug}/-/credentials',
			'/account/secrets',
			'/account/secret-providers',
			'/connect/secrets',
			'/connect/secret-set',
			'/account/credentials',
			'/@{$orgSlug}/-/secrets',
			'/@{$orgSlug}/-/secret-providers',
		],
		apis: [],
	},
	{
		id: 'integrations',
		title: 'Integrations and OAuth connect',
		file: 'integrations.md',
		paths: [
			'/account/integrations',
			'/connect/oauth',
			'/@{$orgSlug}/-/integrations',
		],
		apis: [],
	},
	{
		id: 'mcp-servers',
		title: 'MCP servers',
		file: 'mcp-servers.md',
		paths: [
			'/account/mcp-servers',
			'/account/mcp-oauth-clients',
			'/account/mcp-servers/oauth/callback',
			'/account/mcp-servers/logos/$serverId',
			'/@{$orgSlug}/-/mcp-servers',
		],
		apis: [],
	},
	{
		id: 'jobs',
		title: 'Jobs',
		file: 'jobs.md',
		paths: ['/account/jobs', '/@{$orgSlug}/-/jobs'],
		apis: [],
	},
	{
		id: 'workflows',
		title: 'Workflows',
		file: 'workflows.md',
		paths: ['/account/workflows', '/@{$orgSlug}/-/workflows'],
		apis: [],
	},
	{
		id: 'webhooks',
		title: 'Webhooks (minted URLs)',
		file: 'webhooks.md',
		paths: [
			'/account/webhooks',
			'/@{$username}/$kodyId/settings',
			'/@{$orgSlug}/-/webhooks',
			'/connect/webhook-apply',
		],
		apis: [],
	},
	{
		id: 'follows',
		title: 'Follows',
		file: 'follows.md',
		paths: ['/@{$username}/$kodyId', '/@{$orgSlug}/-/follows'],
		apis: [],
	},
	{
		id: 'activity',
		title: 'Activity',
		file: 'activity.md',
		paths: ['/account/activity', '/@{$orgSlug}/-/activity'],
		apis: [],
	},
	{
		id: 'waiting',
		title: 'Waiting inbox',
		file: 'waiting.md',
		paths: ['/account/waiting', '/@{$orgSlug}/-/waiting'],
		apis: [],
	},
	{
		id: 'experiments',
		title: 'Experiments',
		file: 'experiments.md',
		paths: ['/account/experiments'],
		apis: [],
	},
	{
		id: 'memories',
		title: 'Memories',
		file: 'memories.md',
		paths: ['/account/memories', '/@{$orgSlug}/-/memories'],
		apis: ['/account/memories-export.json'],
	},
	{
		id: 'email',
		title: 'Email inbox',
		file: 'email.md',
		paths: ['/account/email', '/@{$orgSlug}/-/email'],
		apis: [],
	},
	{
		id: 'billing',
		title: 'Billing, credits, and usage',
		file: 'billing.md',
		paths: [
			'/account/billing',
			'/@{$orgSlug}/-/billing',
			'/@{$orgSlug}/-/billing/success',
			'/@{$orgSlug}/-/usage',
			'/@{$orgSlug}/-/credits',
			'/account/credits',
			'/account/usage',
		],
		apis: [],
	},
	{
		id: 'admin',
		title: 'Admin',
		file: 'admin.md',
		paths: ['/admin'],
		apis: [],
	},
	{
		id: 'community',
		title: 'Community listings and profiles',
		file: 'community.md',
		paths: ['/community', '/@{$username}', '/@{$username}/$kodyId'],
		apis: ['/@{$username}/$kodyId/raw/$ref/$', '/community/$listingId/raw/$'],
	},
	{
		id: 'marketing',
		title: 'Public marketing pages',
		file: 'marketing.md',
		paths: [
			'/',
			'/pricing',
			'/for/business',
			'/faq',
			'/case-studies',
			'/believe',
			'/with/$agent',
			'/compare/n8n-alternatives',
			'/compare/composio-alternatives',
			'/use-cases',
			'/use-cases/mcp-gateway',
			'/use-cases/shared-agent-memory',
			'/use-cases/claude-code-custom-tools',
			'/use-cases/scheduled-workflows',
			'/use-cases/ai-workflow-automation',
			'/integrations/gmail',
			'/integrations/slack',
			'/integrations/claude',

			'/support',
			'/about',
			'/contact',
			'/privacy',
			'/terms',
			'/docs',
			'/guides',
			'/blog',
			'/discord',
		],
		apis: [],
	},
]

/** HTML prefixes that must stay mapped. JSON, assets, and well-known stay out. */
const requiredHtmlPrefixes = [
	'/login',
	'/signup',
	'/onboarding',
	'/reset-password',
	'/verify',
	'/unsubscribe',
	'/account',
	'/admin',
	'/connect/oauth',
	'/connect/secrets',
	'/community',
	'/@{$username}',
	'/@{$orgSlug}',
	'/docs',
] as const

// Read the generated native route inventory without importing UI or server modules.
// This is source inspection for the CLI, not a second route matcher.
function extractNativePaths(source: string) {
	const inventory = source.match(
		/export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/,
	)?.[1]
	if (!inventory)
		throw new Error('Missing generated FileRoutesByFullPath inventory')
	return [
		...new Set(
			[...inventory.matchAll(/^\s*'([^']+)':/gm)].map(
				(match) => match[1]!.replace(/\/$/, '') || '/',
			),
		),
	].toSorted()
}

function isHtmlUserPath(routePath: string) {
	if (routePath.startsWith('/.')) return false
	if (routePath.startsWith('/integrations/')) return false
	if (routePath.startsWith('/webhooks/')) return false
	if (routePath.startsWith('/og/')) return false
	if (routePath.startsWith('/youtube-thumb/')) return false
	if (routePath === '/health' || routePath.startsWith('/health/')) return false
	if (routePath === '/session') return false
	if (routePath === '/sentry-tunnel') return false
	if (
		routePath.endsWith('.json') ||
		routePath.endsWith('.md') ||
		routePath.endsWith('.xml') ||
		routePath.endsWith('.txt') ||
		routePath.endsWith('.png')
	) {
		return false
	}
	return true
}

function featureCoversPath(feature: Feature, routePath: string) {
	return feature.paths.some((owned) => pathCoveredBy(owned, routePath))
}

/** Hub paths that must not swallow sibling Feature Map entries. */
const exactOnlyOwnedPaths = ['/', '/account'] as const

function isExactOnlyOwnedPath(owned: string) {
	return (exactOnlyOwnedPaths as ReadonlyArray<string>).includes(owned)
}

function prefixMatches(prefix: string, routePath: string) {
	if (routePath === prefix) return true
	if (prefix === '/') return routePath === '/'
	return routePath.startsWith(`${prefix}/`)
}

function pathCoveredBy(owned: string, routePath: string) {
	if (routePath === owned) return true
	if (isExactOnlyOwnedPath(owned)) return false
	return routePath.startsWith(`${owned}/`)
}

function catalogCoversPath(catalog: ReadonlyArray<Feature>, routePath: string) {
	return catalog.some((feature) => featureCoversPath(feature, routePath))
}

export function findFeature(
	catalog: ReadonlyArray<Feature>,
	id: string,
): Feature | null {
	return catalog.find((feature) => feature.id === id) ?? null
}

export type CatalogCheckIssue = {
	kind: 'stale-path' | 'unmapped-route' | 'missing-file' | 'unknown-feature'
	id?: string
	path?: string
	file?: string
	detail: string
}

export function checkFeatureCatalog(input: {
	catalog?: ReadonlyArray<Feature>
	routeSource: string
	existingFiles: ReadonlyArray<string>
}): { ok: boolean; issues: Array<CatalogCheckIssue> } {
	const catalog = input.catalog ?? featureCatalog
	const routePaths = extractNativePaths(input.routeSource)
	const files = new Set(input.existingFiles)
	const issues: Array<CatalogCheckIssue> = []

	for (const feature of catalog) {
		if (!files.has(feature.file)) {
			issues.push({
				kind: 'missing-file',
				id: feature.id,
				file: feature.file,
				detail: `${feature.id} is missing ${feature.file}`,
			})
		}
		for (const owned of feature.paths) {
			const present = routePaths.includes(owned)
			if (!present) {
				issues.push({
					kind: 'stale-path',
					id: feature.id,
					path: owned,
					detail: `${feature.id} lists ${owned}, which is not in the generated Start route tree`,
				})
			}
		}
	}

	for (const routePath of routePaths) {
		if (!isHtmlUserPath(routePath)) continue
		if (
			!requiredHtmlPrefixes.some((prefix) => prefixMatches(prefix, routePath))
		) {
			continue
		}
		if (!catalogCoversPath(catalog, routePath)) {
			issues.push({
				kind: 'unmapped-route',
				path: routePath,
				detail: `${routePath} has no Feature Map entry`,
			})
		}
	}

	return { ok: issues.length === 0, issues }
}
