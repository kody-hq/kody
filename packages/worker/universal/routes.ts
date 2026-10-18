// URL builders for links and protocol clients. Start's route tree owns routing.
function segment(value: string | number) {
	if (value == null || String(value) === '')
		throw new Error('URL identifiers cannot be empty.')
	return encodeURIComponent(String(value)).replace(/\./g, '%2E')
}

function filePath(value?: string | number | null) {
	if (value == null) return ''
	const parts = String(value).split('/')
	if (parts.some((part) => part === '.' || part === '..'))
		throw new Error('Relative file paths cannot contain dot segments.')
	return '/' + parts.map(encodeURIComponent).join('/')
}

type SearchOptions = { searchParams?: URLSearchParams | Record<string, string> }
function withSearch(path: string, options?: SearchOptions) {
	const search = new URLSearchParams(options?.searchParams).toString()
	return search ? path + '?' + search : path
}

export const routes = {
	home: { href: () => '/' },
	notFoundPage: { href: () => '/404' },
	internalErrorPage: { href: () => '/500' },
	robotsTxt: { href: () => '/robots.txt' },
	sitemap: { href: () => '/sitemap.xml' },
	authMarkdown: { href: () => '/auth.md' },
	mcpServerCard: { href: () => '/.well-known/mcp/server-card.json' },
	apiCatalog: { href: () => '/.well-known/api-catalog' },
	agentSkillsIndex: { href: () => '/.well-known/agent-skills/index.json' },
	agentSkillMarkdown: {
		href: (params: { skillId: string | number }) =>
			`/.well-known/agent-skills/${segment(params.skillId)}/SKILL.md`,
	},
	securityTxt: { href: () => '/.well-known/security.txt' },
	openaiAppsChallenge: { href: () => '/.well-known/openai-apps-challenge' },
	connectOauth: { href: () => '/connect/oauth' },
	connectCredential: { href: () => '/connect/credential' },
	accountCredentials: { href: () => '/account/credentials' },
	connectSecrets: { href: () => '/connect/secrets' },
	connectSecretSet: { href: () => '/connect/secret-set' },
	connectWebhookApply: { href: () => '/connect/webhook-apply' },
	integrationLogo: {
		href: (
			params: { integrationSlug: string | number },
			options?: SearchOptions,
		) =>
			withSearch(
				`/integrations/logos/${segment(params.integrationSlug)}`,
				options,
			),
	},
	providerMarkLogo: {
		href: (params: { slug: string | number }, options?: SearchOptions) =>
			withSearch(
				`/integrations/provider-marks/${segment(params.slug)}`,
				options,
			),
	},
	accountMcpServerLogo: {
		href: (params: { serverId: string | number }, options?: SearchOptions) =>
			withSearch(
				`/account/mcp-servers/logos/${segment(params.serverId)}`,
				options,
			),
	},
	accountMcpServersOauthCallback: {
		href: () => '/account/mcp-servers/oauth/callback',
	},
	accountRepoIcon: {
		href: (params: { repoId: string | number; iconCommit: string | number }) =>
			`/account/repos/${segment(params.repoId)}/icon/${segment(params.iconCommit)}`,
	},
	accountPackageDetail: {
		href: (params: { packageId: string | number }) =>
			`/account/packages/${segment(params.packageId)}`,
	},
	accountPackageApprovePublish: {
		href: (params: { packageId: string | number }) =>
			`/account/packages/${segment(params.packageId)}/approve-publish`,
	},
	accountPackageApproveCapabilities: {
		href: (params: { packageId: string | number }) =>
			`/account/packages/${segment(params.packageId)}/approve-capabilities`,
	},
	accountPackageFiles: {
		href: (params: {
			packageId: string | number
			relativePath?: string | number | null
		}) =>
			`/account/packages/${segment(params.packageId)}/files${filePath(params.relativePath)}`,
	},
	accountExperiments: { href: () => '/account/experiments' },
	accountMemoriesExport: { href: () => '/account/memories-export.json' },
	accountPasskeys: { href: () => '/account/passkeys' },
	accountMcpOauthClients: { href: () => '/account/mcp-oauth-clients' },
	accountTwoFactor: { href: () => '/account/two-factor' },
	accountCredits: { href: () => '/account/credits' },
	accountUsage: { href: () => '/account/usage' },
	accountExport: { href: () => '/account/export.json' },
	admin: { href: () => '/admin' },
	adminUsers: { href: () => '/admin/users' },
	adminUserDetail: {
		href: (params: { stableUserId: string | number }) =>
			`/admin/users/${segment(params.stableUserId)}`,
	},
	adminAccountDeletion: {
		href: (params: { approvalId: string | number }) =>
			`/admin/account-deletions/${segment(params.approvalId)}`,
	},
	adminRoles: { href: () => '/admin/roles' },
	adminReservedUsernames: { href: () => '/admin/reserved-usernames' },
	adminFeatureFlags: { href: () => '/admin/feature-flags' },
	youtubeThumb: {
		href: (params: { videoId: string | number }) =>
			`/youtube-thumb/${segment(params.videoId)}`,
	},
	adminPlatformIntegrations: { href: () => '/admin/platform-integrations' },
	adminPlatformIntegrationNew: {
		href: () => '/admin/platform-integrations/new',
	},
	adminPlatformIntegrationDetail: {
		href: (params: { slug: string | number }) =>
			`/admin/platform-integrations/${segment(params.slug)}`,
	},
	adminProviderMarks: { href: () => '/admin/provider-marks' },
	adminCodemods: { href: () => '/admin/codemods' },
	adminCommunityReports: { href: () => '/admin/community-reports' },
	adminInsights: { href: () => '/admin/insights' },
	adminPlatformFeedback: {
		href: (_params?: null, options?: SearchOptions) =>
			withSearch('/admin/platform-feedback', options),
	},
	adminSystemEmail: { href: () => '/admin/system-email' },
	blog: { href: () => '/blog' },
	blogRss: { href: () => '/blog/rss.xml' },
	blogPost: {
		href: (params: { slug: string | number }) =>
			`/blog/${segment(params.slug)}`,
	},
	blogPostMarkdown: {
		href: (params: { slug: string | number }) =>
			`/blog/${segment(params.slug)}.md`,
	},
	blogPostOgImage: {
		href: (params: { slug: string | number }) =>
			`/blog/${segment(params.slug)}/og.png`,
	},
	docs: { href: () => '/docs' },
	docsMarkdown: { href: () => '/docs.md' },
	docsLlmsTxt: { href: () => '/docs/llms.txt' },
	docsConnect: { href: () => '/docs/connect' },
	docsConnectMarkdown: { href: () => '/docs/connect.md' },
	docDetail: {
		href: (params: { slug: string | number }) =>
			`/docs/${segment(params.slug)}`,
	},
	docDetailMarkdown: {
		href: (params: { slug: string | number }) =>
			`/docs/${segment(params.slug)}.md`,
	},
	docDetailOgImage: {
		href: (params: { slug: string | number }) =>
			`/docs/${segment(params.slug)}/og.png`,
	},
	llmsTxt: { href: () => '/llms.txt' },
	legacyGuides: { href: () => '/guides' },
	legacyGuidesMarkdown: { href: () => '/guides.md' },
	legacyGuidesPath: { href: () => '/guides/*rest' },
	community: {
		href: (_params?: null, options?: SearchOptions) =>
			withSearch('/community', options),
	},
	communityDetail: {
		href: (params: { listingId: string | number }) =>
			`/community/${segment(params.listingId)}`,
	},
	communityDetailFiles: {
		href: (params: {
			listingId: string | number
			relativePath?: string | number | null
		}) =>
			`/community/${segment(params.listingId)}/files${filePath(params.relativePath)}`,
	},
	communityDetailRaw: {
		href: (params: {
			listingId: string | number
			relativePath?: string | number | null
		}) =>
			`/community/${segment(params.listingId)}/raw${filePath(params.relativePath)}`,
	},
	communityDetailAsset: {
		href: (params: {
			listingId: string | number
			relativePath?: string | number | null
		}) =>
			`/community/${segment(params.listingId)}/assets${filePath(params.relativePath)}`,
	},
	communityDetailIcon: {
		href: (params: {
			listingId: string | number
			iconCommit: string | number
		}) =>
			`/community/${segment(params.listingId)}/icon/${segment(params.iconCommit)}`,
	},
	communityDetailOgImage: {
		href: (params: { listingId: string | number }) =>
			`/community/${segment(params.listingId)}/og.png`,
	},
	orgActivity: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/activity${filePath(params.rest)}`,
	},
	orgAgents: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/agents${filePath(params.rest)}`,
	},
	orgApprovalBundle: {
		href: (params: { orgSlug: string | number; bundleId: string | number }) =>
			`/@${segment(params.orgSlug)}/-/approvals/${segment(params.bundleId)}`,
	},
	orgBilling: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/billing`,
	},
	orgBillingSuccess: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/billing/success`,
	},
	orgCredits: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/credits`,
	},
	orgCredentials: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/credentials${filePath(params.rest)}`,
	},
	orgCredentialNew: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/credentials/new`,
	},
	orgUsage: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/usage`,
	},
	orgEmail: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/email${filePath(params.rest)}`,
	},
	orgIntegrations: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/integrations${filePath(params.rest)}`,
	},
	orgJobs: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/jobs${filePath(params.rest)}`,
	},
	orgMcpServers: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/mcp-servers${filePath(params.rest)}`,
	},
	orgMcpServerAuthorize: {
		href: (params: { orgSlug: string | number; serverId: string | number }) =>
			`/@${segment(params.orgSlug)}/-/mcp-servers/${segment(params.serverId)}/authorize`,
	},
	orgMemories: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/memories${filePath(params.rest)}`,
	},
	orgOverview: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/overview`,
	},
	orgRepositories: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/repositories`,
	},
	orgPackages: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/packages`,
	},
	orgConnections: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/connections${filePath(params.rest)}`,
	},
	orgSecretProviders: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) =>
			`/@${segment(params.orgSlug)}/-/secret-providers${filePath(params.rest)}`,
	},
	orgSecrets: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/secrets${filePath(params.rest)}`,
	},
	orgWaiting: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/waiting${filePath(params.rest)}`,
	},
	orgWebhooks: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/webhooks`,
	},
	orgWorkflows: {
		href: (params: {
			orgSlug: string | number
			rest?: string | number | null
		}) => `/@${segment(params.orgSlug)}/-/workflows${filePath(params.rest)}`,
	},
	orgSettings: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/settings`,
	},
	orgMembers: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/members`,
	},
	orgInviteJoin: {
		href: (params: { token: string | number }) =>
			`/join/${segment(params.token)}`,
	},
	orgTeams: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/teams`,
	},
	orgGrants: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/grants`,
	},
	orgCollaborators: {
		href: (params: { orgSlug: string | number }) =>
			`/@${segment(params.orgSlug)}/-/collaborators`,
	},
	orgAvatar: {
		href: (params: {
			orgSlug: string | number
			hash: string | number
			ext: string | number
		}) =>
			`/orgs/${segment(params.orgSlug)}/avatar/${segment(params.hash)}.${segment(params.ext)}`,
	},
	profile: {
		href: (params: { username: string | number }, options?: SearchOptions) =>
			withSearch(`/@${segment(params.username)}`, options),
	},
	communityPackage: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}`,
	},
	communityPackageFiles: {
		href: (params: {
			username: string | number
			kodyId: string | number
			relativePath?: string | number | null
		}) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/files${filePath(params.relativePath)}`,
	},
	communityPackageTree: {
		href: (params: {
			username: string | number
			kodyId: string | number
			ref: string | number
			relativePath?: string | number | null
		}) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/tree/${segment(params.ref)}${filePath(params.relativePath)}`,
	},
	communityPackageRaw: {
		href: (params: {
			username: string | number
			kodyId: string | number
			ref: string | number
			relativePath?: string | number | null
		}) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/raw/${segment(params.ref)}${filePath(params.relativePath)}`,
	},
	communityPackageAsset: {
		href: (params: {
			username: string | number
			kodyId: string | number
			relativePath?: string | number | null
		}) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/assets${filePath(params.relativePath)}`,
	},
	communityPackageIcon: {
		href: (params: {
			username: string | number
			kodyId: string | number
			iconCommit: string | number
		}) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/icon/${segment(params.iconCommit)}`,
	},
	communityPackageSettings: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/settings`,
	},
	communityPackageCredentials: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/credentials`,
	},
	communityPackageMappings: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/mappings`,
	},
	communityPackageTriggers: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/triggers`,
	},
	communityPackageCollaborators: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/collaborators`,
	},
	communityPackageApproveCredentials: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/approve-credentials`,
	},
	communityPackageApprovePublish: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/approve-publish`,
	},
	communityPackageApproveCapabilities: {
		href: (params: { username: string | number; kodyId: string | number }) =>
			`/@${segment(params.username)}/${segment(params.kodyId)}/approve-capabilities`,
	},
	profileAvatar: {
		href: (params: {
			username: string | number
			hash: string | number
			ext: string | number
		}) =>
			`/profiles/${segment(params.username)}/avatar/${segment(params.hash)}.${segment(params.ext)}`,
	},
	profileOgImage: {
		href: (params: { username: string | number }) =>
			`/profiles/${segment(params.username)}/og.png`,
	},
	webhookIngress: {
		href: (params: {
			username: string | number
			packageKodyId: string | number
			webhookName: string | number
			urlSecret: string | number
		}) =>
			`/@${segment(params.username)}/webhooks/${segment(params.packageKodyId)}/${segment(params.webhookName)}/${segment(params.urlSecret)}`,
	},
	stripeWebhook: { href: () => '/webhooks/stripe' },
	health: { href: () => '/health' },
	healthComponents: { href: () => '/health/components' },
	sentryTunnel: { href: () => '/sentry-tunnel' },
	login: {
		href: (_params?: null, options?: SearchOptions) =>
			withSearch('/login', options),
	},
	ogPageImage: {
		href: (params: { page: string | number }) =>
			`/og/${segment(params.page)}.png`,
	},
	features: { href: () => '/features' },
	featureCredentials: { href: () => '/features/credentials' },
	believe: { href: () => '/believe' },
	withAgent: {
		href: (params: { agent: string | number }) =>
			`/with/${segment(params.agent)}`,
	},
	featureMemory: { href: () => '/features/memory' },
	featureSecrets: { href: () => '/features/secrets' },
	featurePackages: { href: () => '/features/packages' },
	featureTriggers: { href: () => '/features/triggers' },
	featureIntegrations: { href: () => '/features/integrations' },
	featureApps: { href: () => '/features/apps' },
	business: { href: () => '/for/business' },
	pricing: { href: () => '/pricing' },
	faq: { href: () => '/faq' },
	caseStudies: { href: () => '/case-studies' },
	n8nAlternatives: { href: () => '/compare/n8n-alternatives' },
	mcpGateway: { href: () => '/use-cases/mcp-gateway' },
	sharedMemory: { href: () => '/use-cases/shared-agent-memory' },
	gmail: { href: () => '/integrations/gmail' },
	customTools: { href: () => '/use-cases/claude-code-custom-tools' },
	composioAlternatives: { href: () => '/compare/composio-alternatives' },
	slack: { href: () => '/integrations/slack' },
	scheduledWorkflows: { href: () => '/use-cases/scheduled-workflows' },
	claudeIntegrations: { href: () => '/integrations/claude' },
	useCases: { href: () => '/use-cases' },
	automation: { href: () => '/use-cases/ai-workflow-automation' },
	support: { href: () => '/support' },
	about: { href: () => '/about' },
	contact: { href: () => '/contact' },
	privacy: { href: () => '/privacy' },
	terms: { href: () => '/terms' },
	discord: { href: () => '/discord' },
	onboarding: { href: () => '/onboarding' },
	onboardingStep1: { href: () => '/onboarding/step-1' },
	onboardingStep1Agent: {
		href: (params: { agent: string | number }) =>
			`/onboarding/step-1/${segment(params.agent)}`,
	},
	onboardingStep2: { href: () => '/onboarding/step-2' },
	onboardingStep2Service: {
		href: (params: { service: string | number }) =>
			`/onboarding/step-2/${segment(params.service)}`,
	},
	onboardingStep3: { href: () => '/onboarding/step-3' },
	onboardingStep3Agent: {
		href: (params: { agent: string | number }) =>
			`/onboarding/step-3/${segment(params.agent)}`,
	},
	resetPassword: { href: () => '/reset-password' },
	verify: { href: () => '/verify' },
	verifyEmail: { href: () => '/verify-email' },
	verifyEmailChange: { href: () => '/verify-email-change' },
	verifyEmailClaimRelease: { href: () => '/verify-email-claim-release' },
	verifyEmailDestination: { href: () => '/verify-email-destination' },
	unsubscribeTips: { href: () => '/unsubscribe/tips' },
	pendingVerification: { href: () => '/pending-verification' },
	signup: { href: () => '/signup' },
	account: { href: () => '/account' },
	accountSecurity: { href: () => '/account/security' },
	accountData: { href: () => '/account/data' },
	accountOrganizations: { href: () => '/account/organizations' },
	accountOrganizationsNew: { href: () => '/account/organizations/new' },
	auth: { href: () => '/auth' },
	authProviderCallback: {
		href: (params: { provider: string | number }) =>
			`/auth/${segment(params.provider)}/callback`,
	},
	session: { href: () => '/session' },
	webauthnRegistration: { href: () => '/webauthn/registration' },
	webauthnAuthentication: { href: () => '/webauthn/authentication' },
}
