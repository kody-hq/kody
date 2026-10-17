import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { isAccountConnectionAgent } from '#universal/account-connections.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { onboardingAgentLabel } from '#universal/onboarding-mcp-clients.ts'
import {
	type PackageCredentialsTab,
	packageCredentialsTabLabel,
} from '#universal/package-credentials-page.ts'
import { docHref, docsIntroSlug } from '#universal/docs-nav.ts'
import {
	homeOgImagePath,
	readHomeOgVariant,
	applyHomeOgVariant,
} from '#universal/home-og-variants.ts'
import { publicOgPages, type PublicOgPageId } from '#universal/og-pages.ts'
import {
	findWithAgentByPathname,
	withAgentHref,
} from '#universal/with-agents.ts'

export const DEFAULT_DOCUMENT_TITLE = 'Kody'
export const NOT_FOUND_DOCUMENT_TITLE = 'Not found'

const INTERNAL_ERROR_DOCUMENT_TITLE = 'Something went wrong'

type DocumentHeadLink = {
	rel: string
	hrefPath: string
	type?: string
	title?: string
	/** Keep href origin-relative for same-origin assets (e.g. stylesheets under CSP). */
	sameOrigin?: boolean
}

type DocumentHeadOg = {
	title: string
	description: string
	imagePath: string
}

/**
 * Route-relative head descriptor. Paths stay origin-relative so the same
 * registry works for SSR (absolute URLs) and SPA updates (`location.origin`).
 */
export type DocumentHeadDescriptor = {
	title: string
	description?: string
	canonicalPath?: string
	og?: DocumentHeadOg
	links?: Array<DocumentHeadLink>
}

export type ResolvedDocumentHead = {
	title: string
	description?: string
	canonicalUrl?: string
	og?: {
		title: string
		description: string
		imageUrl: string
	}
	links?: Array<{
		rel: string
		href: string
		type?: string
		title?: string
	}>
}

type DocumentHeadContext = {
	pathname: string
	search: string
	params: Record<string, string | undefined>
	loaderData?: Partial<AppLoaderData>
}

type DocumentHeadResolver =
	| DocumentHeadDescriptor
	| ((context: DocumentHeadContext) => DocumentHeadDescriptor)

function truncateText(text: string, maxLength: number) {
	const trimmed = text.trim()
	if (trimmed.length <= maxLength) return trimmed
	return `${trimmed.slice(0, maxLength - 1)}…`
}

function titleOnly(title: string): DocumentHeadDescriptor {
	return { title }
}

function packageCredentialsHead(
	tab: PackageCredentialsTab,
): DocumentHeadResolver {
	return ({ loaderData, pathname }) => {
		const page = loaderData?.packageCredentials
		const label = packageCredentialsTabLabel(tab)
		if (page && !page.ok) return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
		if (!page) return titleOnly(`Package ${label.toLowerCase()}`)
		return {
			title: `${page.shell.name} ${label.toLowerCase()}`,
			canonicalPath: pathname,
		}
	}
}

/**
 * Shared by the canonical `/@owner/kody-id` URL and the listing-uuid URL that
 * redirects to it, so a listing describes itself identically either way.
 */
function communityListingHead({
	loaderData,
	pathname,
}: DocumentHeadContext): DocumentHeadDescriptor {
	const shell = loaderData?.communityDetailShell
	if (!shell?.ok) {
		if (shell && 'notFound' in shell) {
			return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
		}
		return titleOnly('Package')
	}
	const title = shell.listingId
		? `${shell.name} — Kody public package`
		: shell.name
	if (!shell.listingId) {
		return {
			title,
			canonicalPath: pathname,
		}
	}
	return {
		title,
		canonicalPath: pathname,
		og: {
			title,
			description: truncateText(shell.description, 200),
			imagePath: `/community/${shell.listingId}/og.png`,
		},
	}
}

/**
 * `/?og=<key>` shares a variant card. The canonical URL stays `/` so the
 * unfurl target does not keep the query. Unknown keys keep the default home
 * card. The browser strips `og` after load; crawlers only see this HTML.
 */
function homeDocumentHead(
	context: DocumentHeadContext,
): DocumentHeadDescriptor {
	const head = publicPageHead('home', publicOgPages.home.ogTitle)
	const variant = readHomeOgVariant(context.search)
	if (!variant || !head.og) return head
	const page = applyHomeOgVariant(publicOgPages.home, variant)
	return {
		...head,
		og: {
			title: page.ogTitle,
			description: page.ogDescription,
			imagePath: homeOgImagePath(variant.id),
		},
	}
}

function publicPageHead(
	pageId: PublicOgPageId,
	title: string,
	extra?: Pick<DocumentHeadDescriptor, 'links'>,
): DocumentHeadDescriptor {
	const page = publicOgPages[pageId]
	return {
		title,
		canonicalPath: page.path,
		og: {
			title: page.ogTitle,
			description: page.ogDescription,
			imagePath: `/og/${pageId}.png`,
		},
		links: extra?.links,
	}
}

/**
 * Feature pages share `feature-pages.css`. A detail page also loads its own
 * animated scenes (`/feature-scenes/<feature>.css`), so no page pays for the
 * other pages' scene styles.
 */
function featurePageHead(
	pageId: PublicOgPageId,
	title: string,
	scenes: string | ReadonlyArray<string> = [],
): DocumentHeadDescriptor {
	const sceneSheets = typeof scenes === 'string' ? [scenes] : scenes
	return {
		...publicPageHead(pageId, title, {
			links: [
				{
					rel: 'stylesheet',
					hrefPath: '/feature-pages.css',
					sameOrigin: true,
				},
				...sceneSheets.map((scene) => ({
					rel: 'stylesheet',
					hrefPath: `/feature-scenes/${scene}.css`,
					sameOrigin: true,
				})),
			],
		}),
		description: publicOgPages[pageId].ogDescription,
	}
}

/**
 * `/docs` and `/docs/:slug` share one head: the introduction is canonical at
 * `/docs` itself, every other doc at its own `/docs/:slug`.
 */
function docDetailHead({
	loaderData,
}: DocumentHeadContext): DocumentHeadDescriptor {
	const doc = loaderData?.docDetail
	if (!doc?.ok) {
		return titleOnly('Docs')
	}
	const title =
		doc.slug === docsIntroSlug ? 'Kody Docs' : `${doc.title} — Kody Docs`
	return {
		title,
		description: doc.summary,
		canonicalPath: docHref(doc.slug),
		...(doc.ogImage
			? {
					og: {
						title,
						description: doc.summary,
						imagePath: `/docs/${encodeURIComponent(doc.slug).replaceAll('.', '%2E')}/og.png`,
					},
				}
			: {}),
	}
}

/**
 * Single registry for document head metadata (title, OG/Twitter, canonical,
 * alternate links). SSR and the client router both resolve from here so SPA
 * navigations keep `<head>` in sync without per-route wiring.
 */
const routeDocumentHeads = {
	home: homeDocumentHead,
	account: titleOnly('Account settings'),
	accountSecurity: titleOnly('Security'),
	accountData: titleOnly('Data & deletion'),
	accountOrganizations: titleOnly('Organizations'),
	orgBilling: titleOnly('Billing'),
	orgBillingSuccess: titleOnly("You're in"),
	orgUsage: titleOnly('Usage'),
	orgCredits: titleOnly('Credits'),
	accountUsage: titleOnly('Usage'),
	accountExperiments: titleOnly('Experiments'),
	communityPackageApproveCredentials: titleOnly('Approve credential mappings'),
	orgApprovalBundle: titleOnly('Review approvals'),
	communityPackageApprovePublish: titleOnly('Approve package publish'),
	communityPackageApproveCapabilities: titleOnly(
		'Approve internet-visible capabilities',
	),
	accountPackageFiles: ({ loaderData }) => {
		const files = loaderData?.packageFiles
		return titleOnly(files?.ok ? `${files.title} files` : 'Package files')
	},
	accountPasskeys: titleOnly('Passkeys'),
	accountMcpOauthClients: titleOnly('MCP OAuth clients'),
	accountTwoFactor: titleOnly('Two-factor authentication'),
	admin: titleOnly('Admin users'),
	adminUsers: titleOnly('Admin users'),
	adminUserDetail: titleOnly('Admin users'),
	adminReservedUsernames: titleOnly('Admin reserved usernames'),
	adminFeatureFlags: titleOnly('Admin feature flags'),
	adminPlatformIntegrations: titleOnly('Admin platform integrations'),
	adminPlatformIntegrationNew: titleOnly('Admin platform integrations'),
	adminPlatformIntegrationDetail: titleOnly('Admin platform integrations'),
	adminProviderMarks: titleOnly('Admin provider marks'),
	adminCodemods: titleOnly('Admin codemods'),
	adminRoles: titleOnly('Admin roles'),
	adminCommunityReports: titleOnly('Community reports'),
	adminInsights: titleOnly('Admin insights'),
	adminPlatformFeedback: titleOnly('Admin platform feedback'),
	adminSystemEmail: titleOnly('Admin system email'),
	blog: publicPageHead('blog', 'Blog', {
		links: [
			{
				rel: 'alternate',
				type: 'application/rss+xml',
				title: 'Kody Blog RSS',
				hrefPath: '/blog/rss.xml',
			},
		],
	}),
	blogPost: ({ loaderData, pathname }) => {
		const post = loaderData?.blogPost
		if (!post?.ok) {
			return titleOnly('Blog')
		}
		const title = `${post.title} — Kody Blog`
		return {
			title,
			canonicalPath: pathname,
			og: {
				title,
				description: post.description,
				imagePath: `/blog/${post.slug}/og.png`,
			},
		}
	},
	docs: docDetailHead,
	docsConnect: ({ pathname }) => ({
		title: 'Connect a provider — Kody Docs',
		description:
			'Verified walkthroughs for connecting Discord, GitHub, Google, Notion, Origin, Salesforce, Slack, or Spotify to Kody.',
		canonicalPath: pathname,
	}),
	docDetail: docDetailHead,
	community: publicPageHead('community', 'Public packages'),
	communityDetail: communityListingHead,
	communityPackage: communityListingHead,
	communityPackageSettings: ({ loaderData, pathname }) => {
		const shell = loaderData?.communityDetailShell
		if (!shell?.ok) {
			if (shell && 'notFound' in shell) {
				return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
			}
			return titleOnly('Package settings')
		}
		return {
			title: `${shell.name} settings`,
			canonicalPath: pathname,
		}
	},
	communityPackageCredentials: packageCredentialsHead('credentials'),
	communityPackageMappings: packageCredentialsHead('mappings'),
	communityPackageTriggers: packageCredentialsHead('triggers'),
	communityPackageCollaborators: ({ loaderData, pathname }) => {
		const page = loaderData?.packageCollaborators
		if (page && !page.ok) return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
		if (!page) return titleOnly('Package collaborators')
		return {
			title: `${page.shell.name} collaborators`,
			canonicalPath: pathname,
		}
	},
	communityDetailFiles: ({ loaderData, pathname }) => {
		const files = loaderData?.packageFiles
		if (!files?.ok) return titleOnly('Package files')
		return {
			title: `${files.title} files`,
			canonicalPath: pathname,
		}
	},
	communityPackageFiles: ({ loaderData, pathname }) => {
		const files = loaderData?.packageFiles
		if (!files?.ok) return titleOnly('Package files')
		return {
			title: `${files.title} files`,
			canonicalPath: pathname,
		}
	},
	communityPackageTree: ({ loaderData, pathname }) => {
		const files = loaderData?.packageFiles
		if (!files?.ok) return titleOnly('Package files')
		return {
			title: `${files.title} files`,
			canonicalPath: pathname,
		}
	},
	profile: ({ loaderData, params, pathname }) => {
		const shell = loaderData?.profileShell
		if (shell && !shell.ok) {
			return titleOnly('Profile unavailable')
		}
		if (!shell?.ok) {
			const username = params.username
			return titleOnly(username ? `@${username}` : 'Profile')
		}

		const title = shell.displayName
		if (shell.visibility !== 'public') {
			return titleOnly(title)
		}

		const ogTitle = `${shell.displayName} (@${shell.username}) — Kody`
		const ogDescription =
			shell.bio == null || shell.bio.trim() === ''
				? 'Community profile on Kody.'
				: truncateText(shell.bio, 200)
		return {
			title,
			canonicalPath: pathname,
			og: {
				title: ogTitle,
				description: ogDescription,
				imagePath: `/profiles/${shell.username}/og.png`,
			},
		}
	},
	notFoundPage: titleOnly(NOT_FOUND_DOCUMENT_TITLE),
	internalErrorPage: titleOnly(INTERNAL_ERROR_DOCUMENT_TITLE),
	login: publicPageHead('login', DEFAULT_DOCUMENT_TITLE),
	signup: publicPageHead('signup', DEFAULT_DOCUMENT_TITLE),
	onboarding: publicPageHead('onboarding', 'Get started'),
	onboardingStep1: publicPageHead('onboarding', 'Get started'),
	onboardingStep1Agent: publicPageHead('onboarding', 'Get started'),
	onboardingStep2: publicPageHead('onboarding', 'Get started'),
	onboardingStep2Service: publicPageHead('onboarding', 'Get started'),
	onboardingStep3: publicPageHead('onboarding', 'Get started'),
	onboardingStep3Agent: publicPageHead('onboarding', 'Get started'),
	pendingVerification: titleOnly('Verify your email'),
	features: featurePageHead(
		'features',
		'Kody features for your AI agents | Kody',
	),
	featureMemory: featurePageHead(
		'feature-memory',
		'Shared memory for your AI agents | Kody',
		'memory',
	),
	featurePackages: featurePageHead(
		'feature-packages',
		'Reusable packages for your AI agents | Kody',
		'packages',
	),
	featureTriggers: featurePageHead(
		'feature-triggers',
		'Triggers and automation for your AI agents | Kody',
		'triggers',
	),
	featureCredentials: featurePageHead(
		'feature-credentials',
		'Credentials for your AI agents | Kody',
		['secrets', 'integrations'],
	),
	featureApps: featurePageHead(
		'feature-apps',
		'Package apps for your AI agents | Kody',
		'apps',
	),
	business: publicPageHead(
		'business',
		'AI Agent Cloud for Business and Agencies | Kody',
	),
	pricing: publicPageHead('pricing', 'Pricing'),
	faq: publicPageHead('faq', 'FAQ'),
	n8nAlternatives: acquisitionHead,
	mcpGateway: acquisitionHead,
	sharedMemory: acquisitionHead,
	gmail: acquisitionHead,
	customTools: acquisitionHead,
	composioAlternatives: acquisitionHead,
	slack: acquisitionHead,
	scheduledWorkflows: acquisitionHead,
	claudeIntegrations: acquisitionHead,
	useCases: acquisitionHead,
	automation: acquisitionHead,
	caseStudies: publicPageHead('case-studies', 'Case studies'),
	believe: publicPageHead('believe', 'What we believe'),
	withAgent: withAgentHead,
	support: publicPageHead('support', 'Support'),
	about: publicPageHead('about', 'About Kody'),
	contact: publicPageHead('contact', 'Contact Kody'),
	privacy: publicPageHead('privacy', 'Privacy'),
	terms: publicPageHead('terms', 'Terms'),
	discord: publicPageHead('discord', 'Discord'),
	resetPassword: publicPageHead('reset-password', 'Reset password'),
	orgInviteJoin: ({ loaderData }) => {
		const join = loaderData?.orgInviteJoin
		if (join?.ok) {
			const name = join.org.displayName?.trim() || join.org.slug
			return titleOnly(`Join ${name}`)
		}
		return titleOnly('Invite link')
	},
	verify: titleOnly('Two-factor authentication'),
	connectOauth: ({ loaderData }) => {
		const provider = loaderData?.connectOauth?.provider?.trim()
		return titleOnly(provider ? `Connect ${provider}` : 'Connect an account')
	},
	connectSecrets: titleOnly('Allow secret hosts'),
	connectCredential: titleOnly('Add a credential'),
	connectSecretSet: titleOnly('Set secret'),
	connectWebhookApply: titleOnly('Approve webhook apply destination'),
	oauthAuthorize: titleOnly('Authorize access'),
	packageAppOauthAuthorize: titleOnly('Allow package app'),
	oauthCallback: titleOnly('OAuth callback'),
} as const satisfies Record<string, DocumentHeadResolver>

const orgDocumentHeads = {
	orgActivity: titleOnly('Activity'),
	orgAgents: ({ pathname }) => {
		const rest = pathname.split('/-/agents/')[1]?.replace(/\/$/, '') ?? ''
		if (rest === 'new') return titleOnly('Connect an agent')
		if (rest === 'usage') return titleOnly('Connection usage')
		if (rest.startsWith('new/')) {
			const agent = rest.slice('new/'.length).split('/')[0] ?? ''
			let decoded = agent
			try {
				decoded = decodeURIComponent(agent)
			} catch {
				decoded = agent
			}
			return titleOnly(
				isAccountConnectionAgent(decoded)
					? `Connect ${onboardingAgentLabel(decoded)}`
					: 'Connect an agent',
			)
		}
		return titleOnly('Agents')
	},
	orgCredentials: titleOnly('Credentials'),
	orgCredentialNew: titleOnly('Add a credential'),
	orgEmail: titleOnly('Email inbox'),
	orgIntegrations: titleOnly('Integrations'),
	orgJobs: titleOnly('Jobs'),
	orgMcpServers: titleOnly('MCP servers'),
	orgMemories: titleOnly('Memories'),
	orgFollows: titleOnly('Follows'),
	orgOverview: titleOnly('Overview'),
	orgRepositories: titleOnly('Repositories'),
	orgSecretProviders: titleOnly('Secret providers'),
	orgSecrets: titleOnly('Secrets'),
	orgWaiting: titleOnly('Waiting'),
	orgWebhooks: titleOnly('Webhooks'),
	orgWorkflows: titleOnly('Workflows'),
	// Static `/-/` outranks `/@:username/:kodyId/settings` (kodyId would be `-`).
	orgSettings: titleOnly('Settings'),
	orgMembers: titleOnly('Members'),
	orgTeams: titleOnly('Teams'),
	orgGrants: titleOnly('Grants'),
	orgCollaborators: titleOnly('Collaborators'),
	accountOrganizationsNew: titleOnly('Create organization'),
} as const satisfies Record<string, DocumentHeadResolver>

const documentHeads = { ...routeDocumentHeads, ...orgDocumentHeads } as const
export type DocumentHeadKey = keyof typeof documentHeads

/** The native route selects metadata. This function never matches URL paths. */
export function resolveDocumentHead(
	key: DocumentHeadKey,
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
	search = '',
	params: Record<string, string | undefined> = {},
): DocumentHeadDescriptor {
	const resolver: DocumentHeadResolver = documentHeads[key]
	const descriptor =
		typeof resolver === 'function'
			? resolver({ pathname, search, params, loaderData })
			: resolver

	const description = descriptor.description ?? descriptor.og?.description
	if (description === undefined) return descriptor
	return { ...descriptor, description }
}

export function absolutizeDocumentHead(
	descriptor: DocumentHeadDescriptor,
	origin: string,
): ResolvedDocumentHead {
	const normalizedOrigin = origin.replace(/\/$/, '')
	const toAbsolute = (path: string) =>
		path.startsWith('http://') || path.startsWith('https://')
			? path
			: `${normalizedOrigin}${path.startsWith('/') ? path : `/${path}`}`

	return {
		title: descriptor.title,
		description: descriptor.description,
		canonicalUrl: descriptor.canonicalPath
			? toAbsolute(descriptor.canonicalPath)
			: undefined,
		og: descriptor.og
			? {
					title: descriptor.og.title,
					description: descriptor.og.description,
					imageUrl: toAbsolute(descriptor.og.imagePath),
				}
			: undefined,
		links: descriptor.links?.map((link) => ({
			rel: link.rel,
			href: link.sameOrigin ? link.hrefPath : toAbsolute(link.hrefPath),
			type: link.type,
			title: link.title,
		})),
	}
}

function withAgentHead({
	pathname,
}: {
	pathname: string
}): DocumentHeadDescriptor {
	const agent = findWithAgentByPathname(pathname)
	if (!agent) return titleOnly('Agent not found')
	const title = `Kody for ${agent.name} | Kody`
	return {
		title,
		description: agent.pitch,
		canonicalPath: withAgentHref(agent.slug),
		og: { title, description: agent.pitch, imagePath: '/og/home.png' },
	}
}

function acquisitionHead({
	pathname,
}: {
	pathname: string
}): DocumentHeadDescriptor {
	const page = acquisitionPageSummaries.find((entry) => entry.path === pathname)
	if (!page) return { title: NOT_FOUND_DOCUMENT_TITLE }
	const title = `${page.title} | Kody`
	return {
		title,
		description: page.description,
		canonicalPath: page.path,
		og: { title, description: page.description, imagePath: '/og/home.png' },
	}
}
