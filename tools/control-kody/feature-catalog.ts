type RouteKind =
	| 'html'
	| 'json'
	| 'raw'
	| 'webhook'
	| 'asset'
	| 'markdown'
	| 'feed'
	| 'protocol'
	| 'well-known'
	| 'error'

export type GeneratedRoute = {
	path: string
	kind: RouteKind
	featureId: string | null
}

/**
 * Verification notes for a user-facing surface. Routes are generated from
 * `routeTree.gen.ts`; `prefixes` only assign those routes to a notes file
 * (longest match wins). Do not hand-maintain path lists.
 */
export type Feature = {
	id: string
	title: string
	file: string
	prefixes: Array<string>
}

export const featuresDirRelativePath = pathToFeaturesDir()

function pathToFeaturesDir() {
	return '.agents/skills/control-kody/references/features'
}

/**
 * Prefix → feature ownership. Keep this small: add a prefix when a new
 * user-facing area needs verification notes, not for every leaf route.
 */
export const featureCatalog: ReadonlyArray<Feature> = [
	{
		id: 'login',
		title: 'Sign in',
		file: 'login.md',
		prefixes: [
			'/login',
			'/auth',
			'/auth.md',
			'/session',
			'/oauth',
			'/-/auth',
			'/_kody/auth',
		],
	},
	{
		id: 'signup',
		title: 'Sign up and email verify',
		file: 'signup.md',
		prefixes: [
			'/signup',
			'/verify-email',
			'/pending-verification',
			'/verify-email-change',
			'/verify-email-claim-release',
			'/verify-email-destination',
			'/unsubscribe',
		],
	},
	{
		id: 'onboarding',
		title: 'Onboarding',
		file: 'onboarding.md',
		prefixes: ['/onboarding'],
	},
	{
		id: 'password-reset',
		title: 'Password reset',
		file: 'password-reset.md',
		prefixes: ['/reset-password'],
	},
	{
		id: 'two-factor',
		title: 'Two-factor auth',
		file: 'two-factor.md',
		prefixes: ['/account/two-factor', '/verify'],
	},
	{
		id: 'passkeys',
		title: 'Passkeys',
		file: 'passkeys.md',
		prefixes: ['/account/passkeys'],
	},
	{
		id: 'account',
		title: 'Account hub',
		file: 'account.md',
		prefixes: [
			'/account',
			'/account/security',
			'/account/data',
			'/account/organizations',
			'/account/export.json',
			'/@{$orgSlug}/-/overview',
			'/@{$orgSlug}/-/settings',
			'/@{$orgSlug}/-/members',
			'/@{$orgSlug}/-/teams',
			'/@{$orgSlug}/-/grants',
			'/@{$orgSlug}/-/collaborators',
			'/join',
		],
	},
	{
		id: 'connections',
		title: 'Agents (connected agents)',
		file: 'connections.md',
		prefixes: [
			'/account/agents',
			'/account/connections',
			'/@{$orgSlug}/-/agents',
			'/@{$orgSlug}/-/connections',
		],
	},
	{
		id: 'packages',
		title: 'Packages',
		file: 'packages.md',
		prefixes: [
			'/account/packages',
			'/account/packages.json',
			'/account/repos',
			'/@{$username}',
			'/@{$orgSlug}/-/packages',
			'/@{$orgSlug}/-/repositories',
			'/@{$orgSlug}/-/approvals',
		],
	},
	{
		id: 'secrets',
		title: 'Secrets',
		file: 'secrets.md',
		prefixes: [
			'/account/secrets',
			'/account/credentials',
			'/account/secret-providers',
			'/connect/secrets',
			'/connect/secret-set',
			'/connect/credential',
			'/@{$orgSlug}/-/secrets',
			'/@{$orgSlug}/-/credentials',
			'/@{$orgSlug}/-/secret-providers',
		],
	},
	{
		id: 'integrations',
		title: 'Integrations and OAuth connect',
		file: 'integrations.md',
		prefixes: [
			'/account/integrations',
			'/connect/oauth',
			'/@{$orgSlug}/-/integrations',
			'/integrations',
		],
	},
	{
		id: 'mcp-servers',
		title: 'MCP servers',
		file: 'mcp-servers.md',
		prefixes: [
			'/account/mcp-servers',
			'/account/mcp-oauth-clients',
			'/@{$orgSlug}/-/mcp-servers',
		],
	},
	{
		id: 'jobs',
		title: 'Jobs',
		file: 'jobs.md',
		prefixes: ['/account/jobs', '/@{$orgSlug}/-/jobs'],
	},
	{
		id: 'workflows',
		title: 'Workflows',
		file: 'workflows.md',
		prefixes: ['/account/workflows', '/@{$orgSlug}/-/workflows'],
	},
	{
		id: 'webhooks',
		title: 'Webhooks (minted URLs)',
		file: 'webhooks.md',
		prefixes: [
			'/account/webhooks',
			'/@{$orgSlug}/-/webhooks',
			'/connect/webhook-apply',
			'/@{$username}/webhooks',
			'/webhooks',
		],
	},
	{
		id: 'follows',
		title: 'Follows',
		file: 'follows.md',
		prefixes: ['/@{$orgSlug}/-/follows'],
	},
	{
		id: 'activity',
		title: 'Activity',
		file: 'activity.md',
		prefixes: ['/account/activity', '/@{$orgSlug}/-/activity'],
	},
	{
		id: 'waiting',
		title: 'Waiting inbox',
		file: 'waiting.md',
		prefixes: ['/account/waiting', '/@{$orgSlug}/-/waiting'],
	},
	{
		id: 'experiments',
		title: 'Experiments',
		file: 'experiments.md',
		prefixes: ['/account/experiments'],
	},
	{
		id: 'memories',
		title: 'Memories',
		file: 'memories.md',
		prefixes: [
			'/account/memories',
			'/account/memories-export.json',
			'/@{$orgSlug}/-/memories',
		],
	},
	{
		id: 'email',
		title: 'Email inbox',
		file: 'email.md',
		prefixes: ['/account/email', '/@{$orgSlug}/-/email'],
	},
	{
		id: 'billing',
		title: 'Billing, credits, and usage',
		file: 'billing.md',
		prefixes: [
			'/account/billing',
			'/account/credits',
			'/account/usage',
			'/@{$orgSlug}/-/billing',
			'/@{$orgSlug}/-/credits',
			'/@{$orgSlug}/-/usage',
		],
	},
	{
		id: 'admin',
		title: 'Admin',
		file: 'admin.md',
		prefixes: ['/admin'],
	},
	{
		id: 'community',
		title: 'Community listings and profiles',
		file: 'community.md',
		prefixes: ['/community'],
	},
	{
		id: 'marketing',
		title: 'Public marketing pages',
		file: 'marketing.md',
		prefixes: [
			'/',
			'/about',
			'/believe',
			'/blog',
			'/case-studies',
			'/compare',
			'/contact',
			'/discord',
			'/docs',
			'/docs.md',
			'/faq',
			'/features',
			'/for',
			'/guides',
			'/guides.json',
			'/guides.md',
			'/llms.txt',
			'/pricing',
			'/privacy',
			'/robots.txt',
			'/sitemap.xml',
			'/support',
			'/terms',
			'/use-cases',
			'/with',
		],
	},
]

/** User-facing prefixes that must have notes (or an exemption). */
const requiredNotesPrefixes = [
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

/**
 * Generated routes under these prefixes do not need Feature Map notes.
 * Keep reasons short; this is the allowlist for "no verification notes".
 */
const exemptRoutePrefixes: ReadonlyArray<{
	prefix: string
	reason: string
}> = [
	{ prefix: '/health', reason: 'ops probe; use control-kody health' },
	{ prefix: '/sentry-tunnel', reason: 'Sentry ingest tunnel' },
	{ prefix: '/.well-known', reason: 'discovery / ACME / security txt' },
	{ prefix: '/og/', reason: 'Open Graph image asset' },
	{ prefix: '/youtube-thumb/', reason: 'thumbnail proxy asset' },
	{ prefix: '/orgs/', reason: 'avatar asset' },
	{ prefix: '/profiles/', reason: 'avatar / OG asset' },
	{ prefix: '/404', reason: 'error page' },
	{ prefix: '/500', reason: 'error page' },
]

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

function classifyRouteKind(routePath: string): RouteKind {
	if (routePath === '/404' || routePath === '/500') return 'error'
	if (routePath.startsWith('/.well-known')) return 'well-known'
	if (
		routePath === '/auth' ||
		routePath.startsWith('/auth/') ||
		routePath === '/session' ||
		routePath === '/health' ||
		routePath.startsWith('/health/') ||
		routePath.startsWith('/oauth/') ||
		routePath.startsWith('/-/auth') ||
		routePath.startsWith('/_kody/auth') ||
		routePath === '/sentry-tunnel'
	) {
		return 'protocol'
	}
	if (
		routePath.includes('/webhooks/') ||
		routePath === '/webhooks/stripe' ||
		routePath.startsWith('/webhooks/')
	) {
		return 'webhook'
	}
	if (routePath.includes('/raw/') || routePath.endsWith('/raw/$')) return 'raw'
	if (
		routePath.endsWith('.png') ||
		routePath.includes('/icon/') ||
		routePath.includes('/avatar/') ||
		routePath.includes('/logos/') ||
		routePath.includes('/assets/') ||
		routePath.startsWith('/og/') ||
		routePath.startsWith('/youtube-thumb/') ||
		routePath.startsWith('/orgs/') ||
		routePath.startsWith('/profiles/')
	) {
		return 'asset'
	}
	if (routePath.endsWith('.json')) return 'json'
	if (routePath.endsWith('.md')) return 'markdown'
	if (
		routePath.endsWith('.txt') ||
		routePath.endsWith('.xml') ||
		routePath === '/robots.txt' ||
		routePath === '/sitemap.xml' ||
		routePath === '/llms.txt'
	) {
		return 'feed'
	}
	return 'html'
}

/** Hub prefixes that must not swallow sibling Feature Map entries. */
const exactOnlyPrefixes = ['/', '/account'] as const

function isExactOnlyPrefix(prefix: string) {
	return (exactOnlyPrefixes as ReadonlyArray<string>).includes(prefix)
}

/** Feature ownership match. Hubs `/` and `/account` are exact-only. */
function ownershipPrefixMatches(prefix: string, routePath: string) {
	if (routePath === prefix) return true
	if (isExactOnlyPrefix(prefix)) return false
	return routePath.startsWith(`${prefix}/`)
}

/** Required-prefix / exemption coverage (directory match; `/` stays exact). */
function coveragePrefixMatches(prefix: string, routePath: string) {
	if (routePath === prefix) return true
	if (prefix === '/') return false
	return routePath.startsWith(`${prefix}/`)
}

function isExemptRoute(routePath: string) {
	return exemptRoutePrefixes.some(({ prefix }) =>
		coveragePrefixMatches(prefix, routePath),
	)
}

/** Longest matching feature prefix wins; `/` and `/account` are exact-only hubs. */
function assignFeatureId(
	routePath: string,
	catalog: ReadonlyArray<Feature> = featureCatalog,
): string | null {
	let best: { id: string; length: number } | null = null
	for (const feature of catalog) {
		for (const prefix of feature.prefixes) {
			if (!ownershipPrefixMatches(prefix, routePath)) continue
			if (!best || prefix.length > best.length) {
				best = { id: feature.id, length: prefix.length }
			}
		}
	}
	return best?.id ?? null
}

export function buildRouteInventory(input: {
	routeSource: string
	catalog?: ReadonlyArray<Feature>
}): Array<GeneratedRoute> {
	const catalog = input.catalog ?? featureCatalog
	return extractNativePaths(input.routeSource).map((routePath) => ({
		path: routePath,
		kind: classifyRouteKind(routePath),
		featureId: assignFeatureId(routePath, catalog),
	}))
}

export function findFeature(
	catalog: ReadonlyArray<Feature>,
	id: string,
): Feature | null {
	return catalog.find((feature) => feature.id === id) ?? null
}

export function formatRouteInventory(
	routes: ReadonlyArray<GeneratedRoute>,
	catalog: ReadonlyArray<Feature> = featureCatalog,
	filter?: { featureId?: string | null; prefix?: string | null },
) {
	const filtered = routes.filter((route) => {
		if (filter?.featureId && route.featureId !== filter.featureId) return false
		if (filter?.prefix && !coveragePrefixMatches(filter.prefix, route.path))
			return false
		return true
	})
	const byFeature = new Map<string, Array<GeneratedRoute>>()
	const unassigned: Array<GeneratedRoute> = []
	for (const route of filtered) {
		if (!route.featureId) {
			unassigned.push(route)
			continue
		}
		const list = byFeature.get(route.featureId) ?? []
		list.push(route)
		byFeature.set(route.featureId, list)
	}
	const lines: Array<string> = []
	for (const feature of catalog) {
		const list = byFeature.get(feature.id)
		if (!list?.length) continue
		lines.push(`${feature.id}\t${feature.title}`)
		for (const route of list) {
			lines.push(`  ${route.kind}\t${route.path}`)
		}
	}
	if (unassigned.length > 0) {
		lines.push('(unassigned)')
		for (const route of unassigned) {
			lines.push(`  ${route.kind}\t${route.path}`)
		}
	}
	return lines.join('\n')
}

export type CatalogCheckIssue = {
	kind:
		| 'missing-file'
		| 'orphan-notes'
		| 'unknown-route-ref'
		| 'unmapped-required'
		| 'missing-inventory'
	id?: string
	path?: string
	file?: string
	detail: string
}

/** Normalize a path written in notes to the FileRoutesByFullPath form. */
function normalizeNotesRouteRef(raw: string): string {
	let path = raw.trim()
	const hash = path.indexOf('#')
	if (hash >= 0) path = path.slice(0, hash)
	const query = path.indexOf('?')
	if (query >= 0) path = path.slice(0, query)
	path = path.replace(/\/$/, '') || '/'
	path = path
		.replace(/\/@<slug>/g, '/@{$orgSlug}')
		.replace(/\/@<orgSlug>/g, '/@{$orgSlug}')
		.replace(/\/@:orgSlug/g, '/@{$orgSlug}')
		.replace(/\/@username\b/g, '/@{$username}')
		.replace(/\/@<username>/g, '/@{$username}')
		.replace(/\/:([A-Za-z_][\w]*)/g, '/$$$1')
		.replace(/\/\{([A-Za-z_][\w]*)\}/g, '/$$$1')
	// `$kodyId` / `:kodyId` already handled; leaf package paths use `$kodyId`
	path = path.replace(/\/:kodyId\b/g, '/$kodyId')
	return path
}

/**
 * Paths in backticks that look like app routes. Skips prose examples that are
 * not rooted paths (no spaces, starts with `/`).
 */
function extractNotesRouteRefs(markdown: string): Array<string> {
	const refs = new Set<string>()
	for (const match of markdown.matchAll(/`(\/[^`\s]+)`/g)) {
		const raw = match[1]!
		if (raw.includes('…') || raw.includes('...')) continue
		refs.add(normalizeNotesRouteRef(raw))
	}
	return [...refs].toSorted()
}

function inventoryHasRoute(
	routePaths: ReadonlyArray<string>,
	notePath: string,
): boolean {
	if (routePaths.includes(notePath)) return true
	// Allow notes to cite a prefix that owns splat children
	return routePaths.some(
		(routePath) =>
			routePath.startsWith(`${notePath}/`) ||
			(notePath.endsWith('/$') && routePath.startsWith(notePath.slice(0, -1))),
	)
}

function notesCoverRequiredPrefix(
	catalog: ReadonlyArray<Feature>,
	requiredPrefix: string,
): boolean {
	return catalog.some((feature) =>
		feature.prefixes.some(
			(owned) =>
				coveragePrefixMatches(requiredPrefix, owned) ||
				coveragePrefixMatches(owned, requiredPrefix) ||
				owned === requiredPrefix,
		),
	)
}

export function checkFeatureCatalog(input: {
	catalog?: ReadonlyArray<Feature>
	routeSource: string
	existingFiles: ReadonlyArray<string>
	notesBodies?: ReadonlyMap<string, string>
}): { ok: boolean; issues: Array<CatalogCheckIssue> } {
	const catalog = input.catalog ?? featureCatalog
	const issues: Array<CatalogCheckIssue> = []
	let routePaths: Array<string>
	try {
		routePaths = extractNativePaths(input.routeSource)
	} catch (error) {
		issues.push({
			kind: 'missing-inventory',
			detail:
				error instanceof Error
					? error.message
					: 'Failed to read FileRoutesByFullPath',
		})
		return { ok: false, issues }
	}

	const files = new Set(input.existingFiles)
	const knownFiles = new Set(catalog.map((feature) => feature.file))
	knownFiles.add('README.md')

	for (const feature of catalog) {
		if (!files.has(feature.file)) {
			issues.push({
				kind: 'missing-file',
				id: feature.id,
				file: feature.file,
				detail: `${feature.id} is missing ${feature.file}`,
			})
		}
	}

	for (const file of files) {
		if (!knownFiles.has(file)) {
			issues.push({
				kind: 'orphan-notes',
				file,
				detail: `${file} is not listed in the Feature Map catalog`,
			})
		}
	}

	const inventory = buildRouteInventory({
		routeSource: input.routeSource,
		catalog,
	})
	const byPath = new Map(inventory.map((route) => [route.path, route]))

	for (const required of requiredNotesPrefixes) {
		if (notesCoverRequiredPrefix(catalog, required)) continue
		if (exemptRoutePrefixes.some(({ prefix }) => prefix === required)) continue
		issues.push({
			kind: 'unmapped-required',
			path: required,
			detail: `${required} has no Feature Map notes entry or exemption`,
		})
	}

	for (const route of inventory) {
		if (route.featureId) continue
		if (isExemptRoute(route.path)) continue
		if (
			!requiredNotesPrefixes.some((prefix) =>
				coveragePrefixMatches(prefix, route.path),
			)
		) {
			continue
		}
		issues.push({
			kind: 'unmapped-required',
			path: route.path,
			detail: `${route.path} is under a required prefix but has no notes feature`,
		})
	}

	if (input.notesBodies) {
		for (const feature of catalog) {
			const body = input.notesBodies.get(feature.file)
			if (body == null) continue
			for (const ref of extractNotesRouteRefs(body)) {
				if (inventoryHasRoute(routePaths, ref)) continue
				// Parameterized note refs may use `$slug` where inventory uses `{$orgSlug}`
				const alt = ref
					.replace('/@{$slug}', '/@{$orgSlug}')
					.replace('/$slug/', '/{$orgSlug}/')
				if (inventoryHasRoute(routePaths, alt)) continue
				if (byPath.has(ref)) continue
				issues.push({
					kind: 'unknown-route-ref',
					id: feature.id,
					path: ref,
					file: feature.file,
					detail: `${feature.id} notes cite ${ref}, which is not in the generated route inventory`,
				})
			}
		}
	}

	return { ok: issues.length === 0, issues }
}
