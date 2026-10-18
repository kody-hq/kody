import {
	type OnboardingFeaturedListing,
	type ProfileVisibility,
	type PublicCommunityActivityItem,
	type PublicCommunityListing,
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'
import { type McpOAuthClientMode } from '@kody-internal/shared/mcp-servers.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { type AdminFeatureFlag } from '#universal/feature-flags/types.ts'
import { type OnboardingChecklistItemId } from '#universal/onboarding-checklist-types.ts'
import {
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
} from '#universal/onboarding-mcp-chooser.ts'
import {
	type CommunityCategoryCounts,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import { type CommunityListingSort } from '#universal/community-search.ts'
import { type AccountCredentialsResponse } from '#universal/credentials-list.ts'
import { type ApprovalBundleLoaderData } from '#universal/approval-bundles.ts'
import { type PackageCredentialApprovalLoaderData } from '#universal/package-credential-approval-page.ts'
import { type PackageCollaboratorsLoaderData } from '#universal/package-collaborators.ts'
import { type PackageCredentialsLoaderData } from '#universal/package-credentials-page.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { type PackageFilesContentKind } from '#universal/package-file-media.ts'
import { type PackageRepoActions } from '#universal/package-repo-actions.ts'
import { type WalkthroughHostPick } from '#universal/walkthrough-hosts.ts'
import { type LandingHeroVideo } from '#universal/landing-hero-copy.ts'
import { type ConnectedMcpAgent } from '#universal/connected-mcp-agents.ts'
import { type AccountConnectionUsageLoaderData } from '#universal/connection-usage.ts'
import { type ReferralProgramSummary } from '#universal/referral-program.ts'
import { type SecondAgentStandardGiftState } from '#universal/second-agent-standard-gift.ts'
import { type OnboardingAgentChooserPick } from '#universal/onboarding-mcp-clients.ts'
import { type EmailNotificationDestination } from '#universal/email-destinations.ts'
import { type EmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { type IntegrationAuthFailureView } from '#universal/connection-trouble.ts'
import {
	type ConnectOauthChooserOption,
	type PlatformIntegrationCatalogItem,
} from '#universal/oauth-connect.ts'
import { type WaitingItem } from '#universal/waiting.ts'
import { type OnboardingFunnelStage } from '#universal/onboarding-funnel-point.ts'
import {
	type CreditWalletState,
	type EntitlementLadder,
	type LimitOverrideKey,
	type LimitOverrideValue,
} from '#universal/plans.ts'
import {
	type ComputeIncludeCreditsStatus,
	type ComputeOverageWarningResource,
} from '#universal/compute-overage.ts'
import {
	type AccountActivity,
	type CreditsAlarm,
	type IncludedComputeMeter,
} from '#universal/usage-presentation.ts'
import {
	type CreditAttributionBreakdown,
	type CreditAttributionRow,
} from '#universal/credit-attribution.ts'
import {
	type AccountActivityStatusFilter,
	type AccountActivitySurfaceFilter,
	type AccountActivityTriageFilter,
	type AccountActivityViewFilter,
} from '#universal/account-activity-filters.ts'
import { type FleetPackageErrorRateConcentration } from '#universal/fleet-package-error-rate-concentration.ts'
import { type OrgFollowsLoaderData } from '#universal/follows.ts'

export type { ProfileVisibility }
export type { AdminFeatureFlag }
export type { OnboardingCustomMcpServer, OnboardingFeaturedMcpServer }

export type BlogPostSummaryLoaderData = {
	slug: string
	title: string
	date: string
	description: string
	order: number
}

export type BlogLoaderData = {
	ok: true
	posts: Array<BlogPostSummaryLoaderData>
}

export type BlogPostLoaderData = {
	ok: true
	slug: string
	title: string
	date: string
	description: string
	/** When true, the post page shows the AI-placeholder callout. */
	placeholder: boolean
	image: string | null
	imageAlt: string | null
	ogImage: string | null
	body: string
	/** Highlight tokens for fenced code in `body`, in lexer order. */
	bodyFences?: Array<HighlightedCode>
	/** Next post in catalog order for the post foot; null when alone. */
	readNext: { slug: string; title: string } | null
}

export type DocSummaryLoaderData = {
	slug: string
	id: string
	title: string
	summary: string
	category: 'platform' | 'provider'
	audience: 'everyone' | 'agents'
	/** `#universal/docs-nav.ts` section id; null for unadvertised docs. */
	section: string | null
	provider: string | null
	lastVerified: string | null
}

/** Provider connection index (`/docs/connect`). */
export type DocsConnectLoaderData = {
	ok: true
	guides: Array<DocSummaryLoaderData>
}

export type DocDetailLoaderData = {
	ok: true
	slug: string
	id: string
	title: string
	summary: string
	category: 'platform' | 'provider'
	audience: 'everyone' | 'agents'
	image: string | null
	imageAlt: string | null
	ogImage: string | null
	provider: string | null
	lastVerified: string | null
	body: string
	/** Highlight tokens for fenced code in `body`, in lexer order. */
	bodyFences?: Array<HighlightedCode>
	/** Highlight tokens for interactive walkthrough snippets, keyed by snippet. */
	walkthroughHighlights?: Record<string, HighlightedCode>
	/** How Kody works only: SSR host pick so hydrate shows the same marks. */
	walkthroughHosts?: WalkthroughHostPick
}

export type CommunityIndexGroup = {
	category: CommunityListingCategory
	listings: Array<PublicCommunityListing>
	total: number
}

export type CommunityIndexLoaderData = {
	ok: true
	listings: Array<PublicCommunityListing>
	/**
	 * Present on the unfiltered browse page so the catalog can open as a few
	 * cards per category instead of one long shelf. Search and category
	 * filters keep a flat `listings` grid and leave this null.
	 */
	groups: Array<CommunityIndexGroup> | null
	/**
	 * Catalog-wide active listing counts by stored category. Chips hide
	 * empty buckets from this map so an empty shelf stays quiet and a
	 * large catalog only shows categories that actually have packages.
	 */
	categoryCounts: CommunityCategoryCounts
	query: string | null
	sort: CommunityListingSort
	category: CommunityListingCategory | null
}

export type CommunityDetailLoaderData = {
	ok: true
	listing: PublicCommunityListing | null
	/** True when `/@owner` is publicly reachable. */
	ownerProfilePublic: boolean
	/** True when the signed-in viewer may open the private package view. */
	viewerIsOwner: boolean
	/** True when the signed-in viewer may change the package (settings, publish). */
	viewerCanManage: boolean
	loggedIn: boolean
	viewerIsAdmin: boolean
	forkPrompt: string
	/** Existing fork/install for the signed-in viewer, when one exists. */
	viewerInstall: ViewerListingInstall | null
	readmeFences?: Array<HighlightedCode>
	ownerPackage: AccountPackageDetail | null
	username: string
	invocationUrlOrigin: string
}

type PackageFilesChildLoaderData = {
	name: string
	path: string
	kind: 'file' | 'directory'
}

export type PackageFilesLoaderData = {
	ok: true
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	selectedPath: string
	kind: 'file' | 'directory'
	paths: Array<string>
	children: Array<PackageFilesChildLoaderData>
	content: string | null
	contentPath: string | null
	contentKind: PackageFilesContentKind | null
	language: string | null
	contentByteLength?: number | null
	mediaHref?: string | null
	/** `/raw/` URL for the selected file; null on directory views. */
	rawHref?: string | null
	contentHighlighted?: HighlightedCode | null
	contentFences?: Array<HighlightedCode>
	username?: string
	kodyId?: string
	viewerIsOwner?: boolean
	viewerCanManage?: boolean
	viewerCanManageAccess?: boolean
	isPrivate?: boolean
	isListed?: boolean
	/** False for plain repos that share package chrome. Defaults to true. */
	hasPackage?: boolean
	iconUrl?: string | null
	imageBaseHref?: string | null
	description?: string
	/** True when `/@owner` is publicly reachable. Omit to keep the owner link. */
	ownerProfilePublic?: boolean
	/** Repository action group (same model as the Repo and Settings tabs). */
	repoActions?: PackageRepoActions | null
}

/** SSR-embedded shell data for client-only regions on the detail page. */
type CommunityDetailShellLoaderData = {
	ok: true
	listingId: string | null
	/** Git default-branch name for Files-tab `/tree/:ref` URLs. */
	defaultBranch?: string | null
	name: string
	description: string
	/** True when `/@owner` is publicly reachable. Omit to keep the owner link. */
	ownerProfilePublic?: boolean
	forkPrompt: string
	loggedIn: boolean
	viewerIsAdmin: boolean
	trusted: boolean
	featured: boolean
	readmeContent: string | null
	readmeFences?: Array<HighlightedCode>
	hasAgentsDocs: boolean
	imageBaseHref: string | null
	viewerInstall: ViewerListingInstall | null
	ownerPackage: AccountPackageDetail | null
	/** False for plain repos that share package chrome. Defaults to true. */
	hasPackage?: boolean
	username: string
	kodyId: string
	viewerIsOwner: boolean
	viewerCanManage: boolean
	viewerCanManageAccess?: boolean
	viewerCanPublish?: boolean
	viewerCanDelete?: boolean
	viewerCanAdoptCommunityFork?: boolean
	isPrivate: boolean
	invocationUrlOrigin: string
	/** Repository action group for client-rendered tabs (Settings). */
	repoActions?: PackageRepoActions | null
}

type CommunityPackageUnauthorizedLoaderData = {
	ok: false
	unauthorized: true
}

type CommunityPackageNotFoundLoaderData = {
	ok: false
	notFound: true
}

/** Signed-in viewer cannot open this saved package (private/hidden, no grant). */
type CommunityPackageNoAccessLoaderData = {
	ok: false
	noAccess: true
	username: string
	kodyId: string
	packageName: string
	viewerUsername: string
}

export type ProfileLoaderData = {
	ok: true
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	/** Null when the profile has no activity source (e.g. team org repositories). */
	activity: Array<PublicCommunityActivityItem> | null
	query: string | null
	isSelf: boolean
	loggedIn: boolean
}

/** Package list + activity for `/@username`. Chips and search (`q`) apply client-side. */
export type ProfileListLoaderData = {
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	activity: Array<PublicCommunityActivityItem> | null
}

/** SSR-embedded shell data for the identity header on the profile page. */
export type ProfileShellLoaderData = {
	ok: true
	username: string
	displayName: string
	bio: string | null
	avatarUrl: string | null
	joinedAt: string
	isSelf: boolean
	loggedIn: boolean
	visibility: ProfileVisibility
}

export function toProfileShellLoaderData(
	data: ProfileLoaderData,
): ProfileShellLoaderData {
	return {
		ok: true,
		username: data.profile.username,
		displayName: data.profile.displayName,
		bio: data.profile.bio,
		avatarUrl: data.profile.avatarUrl,
		joinedAt: data.profile.joinedAt,
		isSelf: data.isSelf,
		loggedIn: data.loggedIn,
		visibility: data.profile.visibility,
	}
}

export function toProfileListLoaderData(
	data: ProfileLoaderData,
): ProfileListLoaderData {
	return {
		profile: data.profile,
		packages: data.packages,
		activity: data.activity,
	}
}

type ProfileUnavailableLoaderData = {
	ok: false
	unavailable: true
}

/**
 * Route-keyed loader payloads embedded in AppRoot props during SSR.
 * Add a key here when converting a route; handlers and route components
 * share these types with the JSON API response shapes.
 */
export type AdminUserListItem = {
	stableUserId: string
	username: string
	email: string
	email_verified: boolean
	email_verified_at: string | null
	/** Manual grant (`orgs.plan` on the personal org). */
	plan: AdminPlanName
	manualPlan: AdminPlanName
	stripePlan: AdminPlanName | null
	effectivePlan: AdminPlanName
	/** Raw `orgs.second_agent_standard_gift_expires_at`, or null. */
	secondAgentGiftExpiresAt: string | null
	/** Raw `orgs.referral_standard_credit_expires_at`, or null. */
	referralCreditExpiresAt: string | null
	/**
	 * Later of the two overlay expiry columns (or null). Same value
	 * `resolveEffectivePlanWithSecondAgentGift` / gating use for the overlay.
	 */
	overlayExpiresAt: string | null
	/**
	 * True while a temporary Pro overlay currently raises Free. False for
	 * paid/manual plans even when expiry columns are still set.
	 */
	isProOverlay: boolean
	/**
	 * Which overlay is classifying the current Pro raise.
	 * When both are active, the later expiry wins; equal timestamps prefer
	 * `second_agent_gift`. Null unless `isProOverlay`.
	 */
	overlayType: 'second_agent_gift' | 'referral_credit' | null
	/** `legacy` keeps pre-cut Standard/Pro ceilings while paid access stays continuous. */
	entitlementLadder: EntitlementLadder
	stripeCustomerLinked: boolean
	suspended_at: string | null
	email_outbound_paused_at: string | null
	email_verification_delivery: EmailVerificationDelivery | null
	email_verification_delivery_detail: string | null
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	first_touch_landing_path: string | null
	first_touch_referrer: string | null
	first_mcp_connected_at: string | null
	first_execute_at: string | null
	first_search_at: string | null
	first_saved_package_at: string | null
	mcp_client_name: string | null
	last_active_at: string | null
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

export type AdminUsersLoaderData = {
	ok: true
	users: Array<AdminUserListItem>
	/**
	 * Resolved independently of the filtered/paginated list so a deep link
	 * (or a selected user outside the current page) still has detail data.
	 */
	selectedUser: AdminUserListItem | null
	page: number
	pageSize: number
	total: number
	availableRoles: Array<RoleName>
	availablePlans: Array<AdminPlanName>
}

export type AdminCreditLedgerItem = AccountCreditsLedgerItem & {
	/** Admin who granted (admin grants only). */
	grantedByUsername: string | null
	note: string | null
}

/** Admin view of one account's credit wallet (grant panel + audit). */
export type AdminCreditWalletSummary = {
	ok: true
	stableUserId: string
	username: string
	plan: AdminPlanName
	/** Purchasable Pro: credits unlock limits and debit usage. */
	eligible: boolean
	/** `orgs.admin_credits_eligible`: admin-set, never touched by Stripe. */
	adminCreditsEligible: boolean
	unlocked: boolean
	balanceMicroUsd: number
	recent: Array<AdminCreditLedgerItem>
}

type AdminOrgLimitRow = {
	key: LimitOverrideKey
	label: string
	/** The plan's limit (seat pool and credits ceiling); null = no window. */
	planLimit: number | null
	/** What enforcement uses: the plan limit with active overrides on top. */
	effectiveLimit: number | null
	override: {
		value: LimitOverrideValue
		expiresAt: string | null
		reason: string
		setByUserId: string
		createdAt: string
		updatedAt: string
		active: boolean
	} | null
}

/** Admin view of one org's overridable caps (`/admin/orgs/limits.json`). */
export type AdminOrgLimits = {
	org: { id: string; slug: string; displayName: string | null }
	plan: AdminPlanName
	creditWallet: CreditWalletState
	seats: number
	limits: Array<AdminOrgLimitRow>
}

export type AdminCreatedUserSetup = {
	stableUserId: string
	email: string
	username: string
	setupLink: string
	setupTokenExpiresAt: number
}

/** Admin writes return their outcome, not another copy of the paginated list. */
export type AdminUsersMutationData = {
	ok: true
	updatedUser?: AdminUserListItem | null
	verifyUrl?: string | null
	verifyUrlExpiresAt?: number | null
	createdUser?: AdminCreatedUserSetup
}

type AdminRoleListItem = {
	name: string
	description: string
	permissions: Array<PermissionString>
}

export type AdminRolesLoaderData = {
	ok: true
	roles: Array<AdminRoleListItem>
}

type AdminCommunityReportListItem = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: string
	reporterUserId: string
	reason: string
	status: 'open' | 'resolved' | 'dismissed'
	createdAt: string
	resolvedAt: string | null
	resolutionNote: string | null
}

export type AdminCommunityReportsLoaderData = {
	ok: true
	reports: Array<AdminCommunityReportListItem>
	statusFilter: string
}

type AdminReservedUsernameConflict = {
	username: string
	stableUserId: string
}

export type AdminReservedUsernamesLoaderData = {
	ok: true
	builtIn: Array<string>
	added: Array<string>
	removed: Array<string>
	conflicts: Array<AdminReservedUsernameConflict>
	updatedAt: string | null
	updatedBy: string | null
}

export type AdminFeatureFlagsLoaderData = {
	ok: true
	featureFlags: Array<AdminFeatureFlag>
}

export type YoutubeWatchLoaderData = {
	allowedVideoIds: Array<string>
}

/**
 * Operator view of one platform (built-in) OAuth app. Never carries secret
 * values — `hasClientSecret` is the only trace of the encrypted credential.
 */
export type AdminPlatformIntegrationApp = {
	slug: string
	provider: string
	label: string | null
	description: string | null
	clientId: string
	hasClientSecret: boolean
	tokenUrl: string
	authorizeUrl: string
	deviceAuthorizationUrl: string | null
	apiBaseUrl: string | null
	flow: 'pkce' | 'confidential' | 'device'
	usePkce: boolean | null
	tokenExchangeStyle: 'form' | 'basic-json' | 'basic-form' | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	allowedScopes: Array<string>
	defaultScopes: Array<string>
	requiredHosts: Array<string>
	/** Hard kill for connect. */
	enabled: boolean
	/** Discovery surfaces offer only enabled + published apps. */
	visibility: 'draft' | 'published'
	logoPath: string | null
	connectionCount: number
	createdAt: string
	updatedAt: string
}

export type AdminPlatformIntegrationsLoaderData = {
	ok: true
	apps: Array<AdminPlatformIntegrationApp>
}

export type AdminProviderMark = {
	slug: string
	label: string
	aliases: Array<string>
	builtInAliases: Array<string>
	logoPath: string | null
	createdAt: string
	updatedAt: string
}

export type AdminProviderMarksLoaderData = {
	ok: true
	marks: Array<AdminProviderMark>
}

export type AdminCodemodListItem = {
	id: string
	description: string
}

export type AdminCodemodRunListItem = {
	id: string
	codemodId: string
	mode: string
	scopeUserId: string | null
	initiatedByUserId: string
	filtersJson: string
	status: 'running' | 'completed' | 'failed' | 'abandoned'
	revertOfRunId: string | null
	createdAt: string
	updatedAt: string
}

export type AdminCodemodRunItemListItem = {
	id: string
	runId: string
	userId: string
	packageId: string
	kodyId: string
	status: string
	beforeCommit: string | null
	afterCommit: string | null
	changedPaths: Array<string>
	findings: Array<{ path: string | null; message: string }>
	checkSummaryJson: string | null
	error: string | null
	createdAt: string
	updatedAt: string
}

export type AdminCodemodsLoaderData = {
	ok: true
	codemods: Array<AdminCodemodListItem>
	runs: Array<AdminCodemodRunListItem>
}

export type AdminCodemodRunItemsLoaderData = {
	ok: true
	run: AdminCodemodRunListItem | null
	items: Array<AdminCodemodRunItemListItem>
	nextAfterId: string | null
}

export type AdminUsageMetric =
	| 'execute'
	| 'package_export'
	| 'package_static_call'
	| 'job_run'
	| 'workflow_run'
	| 'outbound_fetch'
	| 'email_send'
	| 'email_received'
	| 'dynamic_worker_day'
	| 'dynamic_worker_cpu'
	| 'durable_object_gb_seconds'
	| 'durable_object_rows_read'
	| 'durable_object_platform_rows_read'

export type AdminUsageEntitlementResource =
	| 'saved_packages'
	| 'scheduled_jobs'
	| 'repo_sessions'
	| 'email_sends_per_day'
	| 'email_receives_per_day'
	| 'stored_email_messages'
	| 'secrets'
	| 'concurrent_workflows'
	| 'storage_bytes'
	| 'execute_unique_workers_per_day'
	| 'outbound_fetches_per_day'
	| 'job_runs_per_day'
	| 'automation_invocations_per_day'

export type AdminPlanName = 'free' | 'standard' | 'pro' | 'max'

export type AdminUsageRollup = {
	metric: AdminUsageMetric
	eventCount: number
	errorCount: number
	totalDurationMs: number
	totalCpuMs: number
	totalBytes: number
}

export type AdminUsageEntitlementConsumption = {
	resource: AdminUsageEntitlementResource
	label: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
}

export type AdminUsageMonthRollup = {
	month: string
	usage: Array<AdminUsageRollup>
}

/**
 * Per-user usage drill-down shown on the admin users page. Loaded lazily
 * for one selected account at a time so admin reads stay O(1) per view
 * regardless of how many users the deployment has.
 */
export type AdminUserUsageLoaderData = {
	ok: true
	stableUserId: string
	username: string
	plan: AdminPlanName
	currentMonth: string
	today: string
	currentMonthUsage: Array<AdminUsageRollup>
	monthUsage: Array<AdminUsageMonthRollup>
	entitlementConsumption: Array<AdminUsageEntitlementConsumption>
	warnings: Array<AdminUsageEntitlementConsumption>
	dynamicWorkerCost: AdminDynamicWorkerCost
	durableObjectDuration: AdminDurableObjectDuration
	costVsPay: AdminCostVsPay
}

export type AdminPaidSource = 'stripe_catalog' | 'none'

/**
 * Operator cost-vs-pay risk. `underwater` is only paid catalog list MRR
 * exceeded by estimated Dynamic Worker cost — not unpaid pennies.
 */
export type AdminCostRiskKind =
	| 'none'
	| 'paid_underwater'
	| 'free_near_allotment'
	| 'missing_price_id'

/**
 * Operator estimate: gross unique-worker-day cost vs catalog list MRR.
 * Not an invoice and not a net Cloudflare bill share.
 */
export type AdminCostVsPay = AdminDynamicWorkerCost & {
	estimatedPaidUsdCents: number
	estimatedMarginUsd: number
	/** True only for catalog-backed paid accounts over list MRR. */
	underwater: boolean
	paidSource: AdminPaidSource
	risk: AdminCostRiskKind
}

export type AdminInsightsTotals = {
	users: number
	verifiedUsers: number
	savedPackages: number
	scheduledJobs: number
	enabledJobs: number
	workflowRuns: number
	activeMemories: number
	storedEmailMessages: number | null
	secrets: number
	activeCommunityListings: number
	passkeys: number
	oauthConnections: number
}

export type AdminInsightsSignupWeek = {
	/** UTC Monday that starts the week, for example `2026-06-29`. */
	weekStart: string
	signups: number
	/** Total registered users at the end of the week. */
	cumulativeUsers: number
}

export type AdminInsightsUsageMonth = {
	month: string
	events: Record<AdminUsageMetric, number>
	errorCount: number
}

export type AdminInsightsEmailDay = {
	day: string
	sends: number
	receives: number
}

/**
 * Platform-wide outbound delivery outcomes from provider delivery events.
 * Bounce and complaint volume is the early-warning signal for shared
 * sender-domain reputation trouble (all users send from one domain).
 */
export type AdminInsightsEmailDeliveryDay = {
	day: string
	delivered: number
	deferred: number
	bounced: number
	failed: number
	rejected: number
	complained: number
}

export type AdminInsightsAuthDay = {
	day: string
	success: number
	failure: number
	rateLimited: number
}

export type AdminInsightsAuthCategory = {
	category: string
	count: number
}

export type AdminInsightsHeatmapCell = {
	/** 0 = Sunday through 6 = Saturday, matching `Date#getUTCDay`. */
	weekday: number
	/** UTC hour of day, 0-23. */
	hour: number
	count: number
}

export type AdminInsightsPlanSlice = {
	plan: string
	count: number
}

export type AdminInsightsLaunchFunnelStep = {
	step:
		| 'signed_up'
		| 'email_verified'
		| 'first_mcp'
		| 'first_search'
		| 'first_execute'
		| 'first_saved_package'
	users: number
}

export type AdminInsightsPaidSlice = {
	plan: 'standard' | 'pro'
	interval: 'month' | 'year' | 'unknown'
	subscribers: number
	/** Monthly-equivalent list revenue in USD cents. Zero when the price is unknown. */
	mrrUsdCents: number
}

export type AdminInsightsMcpClientSlice = {
	kind: string | null
	label: string
	count: number
}

export type AdminInsightsLaunchSignals = {
	openedAt: string
	openedDay: string
	mrrUsdCents: number
	/** Paid Stripe Standard/Pro rows. Gift/referral overlays are not included. */
	paidSubscribers: number
	unpricedPaidSubscribers: number
	paidSlices: Array<AdminInsightsPaidSlice>
	manualPlans: Array<AdminInsightsPlanSlice>
	stripePlans: Array<AdminInsightsPlanSlice>
	effectivePlans: Array<AdminInsightsPlanSlice>
	/** Effective Standard from an active gift or referral while manual+Stripe stay free. */
	overlayPro: number
	entitlementLadders: { public: number; legacy: number }
	paidEntitlementLadders: { public: number; legacy: number }
	activeUsers: { hours24: number; hours48: number; days7: number }
	activation: {
		overall: Array<AdminInsightsLaunchFunnelStep>
		sinceOpen: Array<AdminInsightsLaunchFunnelStep>
	}
	mcpClients: Array<AdminInsightsMcpClientSlice>
	openPlatformFeedback: number
}

export type AdminInsightsWorkflowStatus = {
	status: string
	count: number
}

export type AdminInsightsJobHealth = {
	totalJobs: number
	enabledJobs: number
	successRuns: number
	errorRuns: number
}

/**
 * Ordered activation funnel. Each step counts users who ever reached it, so
 * counts are monotonically non-increasing down the list.
 */
export type AdminInsightsActivationStep = {
	step:
		| 'signed_up'
		| 'email_verified'
		| 'agent_connected'
		| 'package_forked'
		| 'package_run_succeeded'
		| 'package_activated'
	users: number
}

export type AdminInsightsActivation = {
	steps: Array<AdminInsightsActivationStep>
	/**
	 * Forks split by who caused them. Agent-driven forks are real usage but a
	 * weaker activation signal than a person choosing to install something,
	 * and rows predating the distinction are counted as unknown.
	 */
	forksByActor: { human: number; agent: number; unknown: number }
	/**
	 * Median hours from email verification to activation, over users who have
	 * activated. Null when nobody has.
	 */
	medianHoursToActivation: number | null
}

export type AdminInsightsOnboardingFunnelWindow = {
	days: 7 | 28
	steps: Array<{ stage: OnboardingFunnelStage; users: number }>
}

/**
 * Unique stable user ids per funnel stage from Analytics Engine. `available`
 * is false when the SQL API cannot be queried (local dev, missing credentials).
 * Counts are sampled, so they are a floor, not a ledger.
 */
export type AdminInsightsOnboardingFunnel = {
	available: boolean
	windows: {
		days7: AdminInsightsOnboardingFunnelWindow
		days28: AdminInsightsOnboardingFunnelWindow
	}
}

/** Content-free status for the hourly RunLog snapshot that insights reads. */
export type AdminInsightsRunLogCompleteness = {
	usersAttempted: number
	usersLoaded: number
	complete: boolean
	/** When the hourly snapshot was written. Null until the first refresh. */
	snapshotUpdatedAt: string | null
}

export type AdminInsightsDurationConsumer = {
	stableUserId: string
	username: string
	totalDurationMs: number
}

export type AdminInsightsEventCountConsumer = {
	stableUserId: string
	username: string
	eventCount: number
}

type AdminDynamicWorkerCost = {
	uniqueWorkerDays: number
	estimatedGrossUsd: number
	usdPerUniqueDay: number
	includedPerAccountMonth: number
}

type AdminDurableObjectDuration = {
	/** RPC wall-clock proxy (StorageRunner only). */
	gbSeconds: number
	durationMs: number
	rpcCount: number
	memoryGb: number
	/** Cloudflare-measured active time attributed to this user, this month. */
	measured: AdminMeasuredDurableObjectDuration
}

type AdminMeasuredDurableObjectDuration = {
	activeMs: number
	gbSeconds: number
	/** Gross at Cloudflare list, before the account-wide include. */
	estimatedUsd: number
	/** Latest UTC day with attributed rows; null when none yet. */
	lastDay: string | null
	byClass: Array<{ doClass: string; activeMs: number; gbSeconds: number }>
}

export type AdminInsightsDynamicWorkerCostConsumer = {
	stableUserId: string
	username: string
	uniqueWorkerDays: number
	estimatedGrossUsd: number
	estimatedPaidUsdCents: number
	estimatedMarginUsd: number
	/** True only for catalog-backed paid accounts over list MRR. */
	underwater: boolean
	paidSource: AdminPaidSource
	risk: AdminCostRiskKind
}

export type AdminInsightsDynamicWorkerCost = AdminDynamicWorkerCost & {
	topConsumers: Array<AdminInsightsDynamicWorkerCostConsumer>
	riskConsumers: Array<AdminInsightsDynamicWorkerCostConsumer>
}

export type AdminInsightsMetricDurationConsumers = {
	metric: AdminUsageMetric
	consumers: Array<AdminInsightsDurationConsumer>
}

type AdminInsightsEntitlementPressureResource = {
	resource: AdminUsageEntitlementResource
	label: string
	current: number
	limit: number
	percentOfLimit: number
}

export type AdminInsightsEntitlementPressureUser = {
	stableUserId: string
	username: string
	plan: AdminPlanName
	pressuredResources: Array<AdminInsightsEntitlementPressureResource>
}

export type AdminInsightsPackageErrorRateCounts = {
	events: number
	errors: number
	rate: number | null
}

export type AdminInsightsPackageErrorRateMetricRow =
	AdminInsightsPackageErrorRateCounts & {
		metric:
			| 'package_export'
			| 'package_static_call'
			| 'job_run'
			| 'workflow_run'
	}

type AdminInsightsPackageErrorRateWindow = {
	start: string
	end: string
	combined: AdminInsightsPackageErrorRateCounts
	by_metric: Array<AdminInsightsPackageErrorRateMetricRow>
}

type AdminInsightsPackageErrorRateComparison = {
	kind: 'hour' | 'day'
	recent: AdminInsightsPackageErrorRateWindow
	previous: AdminInsightsPackageErrorRateWindow
}

/** Fleet package-runtime error rates. Missing when AE/KV is empty. */
export type AdminInsightsPackageErrorRate = {
	available: boolean
	updatedAt: string | null
	environment: string | null
	day: AdminInsightsPackageErrorRateComparison | null
	hour: AdminInsightsPackageErrorRateComparison | null
	lastAlertAt: string | null
	concentration: FleetPackageErrorRateConcentration | null
}

export type AdminInsightsLoaderData = {
	ok: true
	generatedAt: string
	totals: AdminInsightsTotals
	signupsByWeek: Array<AdminInsightsSignupWeek>
	usageByMonth: Array<AdminInsightsUsageMonth>
	emailByDay: Array<AdminInsightsEmailDay>
	emailDeliveryByDay: Array<AdminInsightsEmailDeliveryDay>
	plans: Array<AdminInsightsPlanSlice>
	authByDay: Array<AdminInsightsAuthDay>
	authByCategory: Array<AdminInsightsAuthCategory>
	authHeatmap: Array<AdminInsightsHeatmapCell>
	workflowStatuses: Array<AdminInsightsWorkflowStatus>
	jobHealth: AdminInsightsJobHealth
	activation: AdminInsightsActivation
	onboardingFunnel: AdminInsightsOnboardingFunnel
	launchSignals: AdminInsightsLaunchSignals
	runLogCompleteness: AdminInsightsRunLogCompleteness
	topRuntimeDurationConsumers: Array<AdminInsightsDurationConsumer>
	topEventCountConsumers: Array<AdminInsightsEventCountConsumer>
	topDurationConsumersByMetric: Array<AdminInsightsMetricDurationConsumers>
	entitlementPressure: Array<AdminInsightsEntitlementPressureUser>
	dynamicWorkerCost: AdminInsightsDynamicWorkerCost
	packageErrorRate: AdminInsightsPackageErrorRate
}

type AdminSystemEmailListItem = {
	id: string
	inbox_local_part: string
	from_address: string | null
	envelope_from: string | null
	subject: string | null
	processing_status: string
	raw_size: number
	received_at: string | null
	created_at: string
	to_addresses: Array<string>
}

type AdminSystemEmailDetail = AdminSystemEmailListItem & {
	cc_addresses: Array<string>
	reply_to_addresses: Array<string>
	headers: Record<string, Array<string>>
	text_body: string | null
	html_body: string | null
	raw_mime: string | null
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		created_at: string
	}>
}

export type AdminSystemEmailLoaderData = {
	ok: true
	ownerId: string
	systemLocals: Array<string>
	limits: {
		maxMessageBytes: number
		maxReceivesPerDay: number
		maxStoredMessages: number
		retentionDays: number
		pruneBatchSize: number
	}
	messages: Array<AdminSystemEmailListItem>
	selectedMessage: AdminSystemEmailDetail | null
	page: number
	pageSize: number
	total: number
}

export type AdminPlatformFeedbackListItem = {
	id: string
	submitter_user_id: string
	category:
		| 'friction'
		| 'bug'
		| 'experience'
		| 'suggestion'
		| 'cancellation'
		| 'other'
	summary_untrusted: string
	status: 'open' | 'triaged' | 'resolved' | 'dismissed'
	reviewed_by_user_id: string | null
	reviewed_at: string | null
	created_at: string
	updated_at: string
}

export type AdminPlatformFeedbackDetail = AdminPlatformFeedbackListItem & {
	details_untrusted: string
	admin_note: string | null
	submitter: {
		user_id: string
		username: string | null
		email: string | null
	} | null
}

export type AdminPlatformFeedbackLoaderData = {
	ok: true
	feedback: Array<AdminPlatformFeedbackListItem>
	selectedFeedback: AdminPlatformFeedbackDetail | null
	page: number
	pageSize: number
	total: number
	statusFilter: AdminPlatformFeedbackListItem['status'] | null
	categoryFilter: AdminPlatformFeedbackListItem['category'] | null
}

export type AccountEmailDestinationsLoaderData = {
	ok: true
	destinations: Array<EmailNotificationDestination>
	additionalLimit: number
	additionalRemaining: number
	message?: string
}

export type AccountFormerEmail = {
	email: string
	claimedAt: string
}

export type AccountOrganizationSummary = {
	slug: string
	displayName: string | null
	role: 'owner' | 'member' | 'billing' | null
	personal: boolean
	avatarUrl?: string | null
}

/** Soft-deleted org the viewer can restore (slug only; no raw id in the UI). */
export type AccountRestorableOrganization = {
	slug: string
	displayName: string | null
	deletedAt: string
	avatarUrl?: string | null
}

export type AccountProfileLoaderData = {
	ok: true
	email: string
	emailVerified: boolean
	emailVerificationDelivery?: EmailVerificationDelivery | null
	username: string
	displayName: string
	bio: string | null
	avatarUrl: string | null
	profileVisibility: ProfileVisibility
	formerEmails: Array<AccountFormerEmail>
}

type AccountOrganizationsNewLoaderData = {
	ok: true
	error: string | null
	/** Soft-deleted handle this person can restore instead of creating. */
	restorableSlug: string | null
	/** What the person typed before a rejected submit, so it is not lost. */
	draft: { displayName: string; slug: string }
}

/**
 * Something waiting on the signed-in person to accept or decline: an invite
 * link they opened (`link`) or an invite addressed to their email or
 * username (`invite`). `id` is only used to build the accept and decline
 * URLs. `label` says what accepting gives ("Join as Member", "Join the
 * Design team", "Use access to weather").
 */
export type AccountPendingInvite = {
	source: 'link' | 'invite'
	id: string
	orgSlug: string
	orgDisplayName: string | null
	orgPersonal: boolean
	label: string
	expiresAt: string
}

export type AccountOrganizationsLoaderData = {
	ok: true
	username: string
	/** The signup organization is named and pictured after the person. */
	viewer: { displayName: string; avatarUrl: string | null }
	organizations: Array<AccountOrganizationSummary>
	/** Soft-deleted orgs this person owned and can restore within 30 days. */
	restorableOrganizations: Array<AccountRestorableOrganization>
	pendingInvites: Array<AccountPendingInvite>
}

type OrgManagementOrg = {
	id: string
	slug: string
	displayName: string | null
	avatarUrl: string | null
	personal: boolean
	role: 'owner' | 'member' | 'billing'
}

type OrgSettingsCustomHostnameDnsRecord = {
	type: string
	name: string
	value: string
}

type OrgSettingsCustomHostnameView = {
	id: string
	hostname: string
	bindingKind: 'app' | 'org'
	packageId: string | null
	hostnameStatus: string
	sslStatus: string
	verifiedAt: string | null
	dnsMissingSince: string | null
	ownershipVerification: OrgSettingsCustomHostnameDnsRecord | null
	sslValidationRecords: Array<OrgSettingsCustomHostnameDnsRecord>
	createdAt: string
	updatedAt: string
}

type OrgSettingsCustomDomainsView = {
	hostnames: Array<OrgSettingsCustomHostnameView>
	dnsTarget: string | null
}

export type OrgSettingsLoaderData = {
	ok: true
	org: OrgManagementOrg
	canManage: boolean
	canDelete: boolean
	/**
	 * Present only when `package-app-custom-domains` is on for this
	 * environment. Null when the flag is off (panel stays hidden).
	 */
	customDomains: OrgSettingsCustomDomainsView | null
}

export type OrgMemberView = {
	userId: string
	username: string | null
	displayName: string | null
	avatarUrl: string | null
	role: 'owner' | 'member' | 'billing'
	roleLabel: string
}

export type OrgInviteView = {
	id: string
	kind: string
	role: 'owner' | 'member' | 'billing' | null
	roleLabel: string | null
	inviteeEmail: string | null
	inviteeUsername: string | null
	expiresAt: string
}

export type OrgInviteLinkView = {
	id: string
	role: 'member' | 'billing'
	roleLabel: string
	allowedEmailDomains: Array<string>
	maxUses: number | null
	useCount: number
	expiresAt: string
	createdAt: string
	createdByUsername: string | null
	createdByDisplayName: string | null
}

export type OrgMembersLoaderData = {
	ok: true
	org: OrgManagementOrg
	members: Array<OrgMemberView>
	invites: Array<OrgInviteView>
	inviteLinks: Array<OrgInviteLinkView>
	canManage: boolean
}

/** What accepting an invite link gives, as the join page describes it. */
export type OrgInviteJoinOffer =
	| { kind: 'membership'; role: 'member' | 'billing'; roleLabel: string }
	| {
			kind: 'team'
			teamName: string
			/** The viewer is not a member yet, so accepting also joins the org. */
			joinsOrg: boolean
	  }
	| {
			kind: 'resource'
			packageName: string
			packageHref: string
			preset: 'use' | 'contribute' | 'manage'
			presetLabel: string
			presetDescription: string
			/** The viewer is not a member, so they stay an outside collaborator. */
			outsideCollaborator: boolean
	  }

export type OrgInviteJoinLoaderData =
	| {
			ok: true
			token: string
			org: {
				slug: string
				displayName: string | null
				avatarUrl: string | null
				personal: boolean
			}
			offer: OrgInviteJoinOffer
			invitedBy: string | null
			expiresAt: string
			/** The viewer already has everything the link gives. */
			alreadyMember: boolean
			authenticated: boolean
	  }
	| {
			ok: false
			error: string
			reason:
				| 'missing'
				| 'invalid'
				| 'revoked'
				| 'expired'
				| 'exhausted'
				| 'org_inactive'
				| 'personal_org'
				| 'target_gone'
				| 'inviter_gone'
				| 'already_used'
	  }

/**
 * An active invite link on a Teams or package Collaborators page. `teamId`
 * groups team links under their team and is never shown.
 */
export type ScopedInviteLinkView = {
	id: string
	label: string
	teamId: string | null
	maxUses: number | null
	useCount: number
	expiresAt: string
	createdByUsername: string | null
	createdByDisplayName: string | null
}

export type PackageInviteLinksView = {
	ok: true
	links: Array<ScopedInviteLinkView>
}

export type OrgTeamMemberView = {
	userId: string
	username: string | null
	displayName: string | null
	avatarUrl: string | null
}

export type OrgTeamView = {
	id: string
	slug: string
	name: string
	description: string | null
	memberCount: number
	members: Array<OrgTeamMemberView>
}

export type OrgTeamsLoaderData = {
	ok: true
	org: OrgManagementOrg
	teams: Array<OrgTeamView>
	/** Org members eligible to add to a team. */
	orgMembers: Array<OrgMemberView>
	canManage: boolean
	canRemoveMembers: boolean
	/** True when the viewer may create team invite links (team and member write). */
	canCreateInviteLinks: boolean
	inviteLinks: Array<ScopedInviteLinkView>
}

export type OrgGrantView = {
	id: string
	resourceType: string
	resourceId: string
	resourceLabel: string
	subjectType: 'user' | 'team'
	subjectId: string
	subjectLabel: string
	preset: string | null
	presetLabel: string | null
	permissions: Array<string>
	createdAt: string
}

export type OrgGrantsLoaderData = {
	ok: true
	org: OrgManagementOrg
	grants: Array<
		OrgGrantView & {
			/**
			 * True when `authorizeGrantRevoke` allows this viewer to revoke the
			 * grant. Denial (including a missing resource permission) is false.
			 * The page still requires `canManage` (`member:write`) before showing
			 * Revoke, matching the delete handler.
			 */
			canRevoke: boolean
		}
	>
	canManage: boolean
}

export type OrgCollaboratorView = {
	userId: string
	username: string | null
	displayName: string | null
	avatarUrl: string | null
	grants: Array<OrgGrantView>
}

export type OrgCollaboratorsLoaderData = {
	ok: true
	org: OrgManagementOrg
	collaborators: Array<OrgCollaboratorView>
	canManage: boolean
}

type AccountConnectionListItem = {
	provider: string
	label: string
	displayName: string | null
	createdAt: string
}

export type AccountConnectionsLoaderData = {
	ok: true
	connections: Array<AccountConnectionListItem>
	canDisconnect: boolean
	hasUsablePassword: boolean
	availableProviders: Array<{ id: string; label: string }>
	/** True when Discord is connected and operator guild-role sync is configured. */
	canSyncDiscordRoles: boolean
}

export type OnboardingLoaderData = {
	ok: true
	loggedIn: boolean
	/** Signed-in package scope owner; null for public onboarding payloads. */
	username: string | null
	mcpServerUrl: string
	/** Highlight tokens for MCP tab snippets, keyed by highlightSnippetKey. */
	mcpHighlights?: Record<string, HighlightedCode>
	setupPrompt: string
	/** Pre-connection "is Kody for me?" prompt; usable in any tool-calling agent. */
	discoveryPrompt: string
	/** Step 3 paste: ad hoc execute, then persist as a package. */
	persistPrompt: string
	/** True when the account has a memory, execute, or saved package. */
	hasAccessWin: boolean
	/**
	 * True when the account has two or more unique inbound MCP OAuth
	 * `clientId`s. That is unique hosts, not raw grant count and not "the
	 * selected Step 3 host connected."
	 */
	hasSecondMcpClient: boolean
	hasMcpClient: boolean
	/** Best-effort labeled inbound MCP hosts, unique by `clientId`. */
	connectedAgents: Array<ConnectedMcpAgent>
	/**
	 * One-gift-per-user Standard overlay after unique inbound clients
	 * first reach 2. Lifecycle email / PackagedSingleClient can read
	 * `received` and `active` without re-deriving the ledger.
	 */
	secondAgentStandardGift: SecondAgentStandardGiftState
	emailVerified: boolean
	needsOnboarding: boolean
	/** Admin-featured listings offered as one-click starter installs. */
	featuredListings: Array<OnboardingFeaturedListing>
	/** Official workspace MCP chooser cards, with viewer connection overlay. */
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	/** Non-featured MCP servers the viewer added themselves. */
	customMcpServers: Array<OnboardingCustomMcpServer>
	/**
	 * Built-in integrations from the onboarding allowlist that are published,
	 * enabled, and not yet connected. Empty (or absent) while every built-in is
	 * draft.
	 */
	featuredPlatformIntegrations?: Array<PlatformIntegrationCatalogItem>
	/**
	 * Most recently updated saved-package user-facing name (`@scope/kody-id`)
	 * for Step 3 "You made …" chrome. Null when logged out, unverified, or
	 * the listing fails open.
	 */
	persistedPackageName: string | null
	/**
	 * Most recently updated active memory subject for Step 3 "You made …"
	 * chrome. Null when logged out, unverified, none exist, or the listing
	 * fails open. The chip truncates long subjects; this field stays raw.
	 */
	accessWinMemorySubject: string | null
	/** Derived progress checklist; null when logged out. */
	checklist: OnboardingChecklistLoaderData | null
}

export type OnboardingChecklistLoaderData = {
	username: string
	items: Array<{
		id: OnboardingChecklistItemId
		done: boolean
	}>
	/** True when the user dismissed the checklist everywhere. */
	dismissed: boolean
}

export type AccountTwoFactorLoaderData = {
	ok: true
	enabled: boolean
}

type AccountPasskeyListItem = {
	id: string
	name: string
	deviceType: string
	backedUp: boolean
	createdAt: string
	lastUsedAt: string | null
}

export type AccountPasskeysLoaderData = {
	ok: true
	passkeys: Array<AccountPasskeyListItem>
}

type AccountMcpOauthClientListItem = {
	id: string
	label: string
	clientId: string
	redirectUris: Array<string>
	createdAt: string
	revokedAt: string | null
}

export type AccountMcpOauthClientsLoaderData = {
	ok: true
	clients: Array<AccountMcpOauthClientListItem>
}

export type AccountConnectedAgentListItem = ConnectedMcpAgent & {
	grantIds: Array<string>
	connectionProfileName: string | null
}

export type AccountConnectionProfileView = {
	id: string
	name: string
	grants: Array<{
		resourceType: string
		resourceId: string
		actions: Array<'read' | 'execute' | 'write'>
	}>
	mcpServerUrl: string
	createdAt: string
	updatedAt: string
}

export type AccountConnectedAgentsLoaderData = {
	ok: true
	agents: Array<AccountConnectedAgentListItem>
	/**
	 * This deployment's MCP URL for connecting another host. Empty until the
	 * account email is verified, matching the onboarding payload, so the page
	 * cannot send an unverified user into the authorize → 403 loop.
	 */
	mcpServerUrl: string
	/** Experimenter-only. Absent/empty when the connection-profiles flag is off. */
	connectionProfilesEnabled?: boolean
	connectionProfiles?: Array<AccountConnectionProfileView>
	/** Owned packages offered when editing profile grants (id + name). */
	connectionProfilePackageOptions?: Array<{
		id: string
		name: string
		kodyId: string
	}>
}

type PackageWebhookVerification =
	| {
			type: 'hmac-sha256' | 'hmac-sha1'
			header: string
			secretName?: string
			encoding: 'hex' | 'base64'
			prefix?: string
			signedPayload?: 'body' | 'timestamp.body'
	  }
	| { type: 'url-secret' }
	| null

type PackageWebhookReplay = {
	timestampHeader?: string
	timestampFormat?:
		| 'unix-seconds'
		| 'unix-millis'
		| 'iso-8601'
		| 'stripe-signature'
	toleranceSeconds?: number
	deliveryIdHeader?: string
} | null

type PackageWebhookChallengeProve =
	| { kind: 'none' }
	| {
			kind: 'verify-token'
			in: 'query'
			key: string
			secretName: string
			required?: boolean
	  }
	| {
			kind: 'hmac'
			secretName: string
			algorithm: 'hmac-sha256'
			encoding: 'hex' | 'base64'
			prefix?: string
	  }
	| {
			kind: 'request-hmac'
			secretName: string
			algorithm: 'hmac-sha256'
			encoding: 'hex' | 'base64'
			prefix?: string
			timestampHeader: string
			signatureHeader: string
			signedPayload: 'v0.timestamp.body'
	  }

type PackageWebhookChallenge = {
	type: 'subscription-challenge'
	method: 'GET' | 'POST'
	challenge: { in: 'query' | 'json'; key: string }
	when?: {
		query?: Record<string, string | Array<string>>
		json?: Record<string, string>
	}
	prove?: PackageWebhookChallengeProve
	respond:
		| { as: 'text' }
		| { as: 'json'; key: string }
		| { as: 'json-hmac'; key: string }
} | null

/**
 * One declared package webhook joined with its minted URL state. Never
 * carries the credential URL or `url_secret`: the settings section fetches
 * those on demand through the `reveal` intent so they are not embedded in
 * SSR HTML or any list payload.
 */
export type PackageWebhookListItem = {
	/**
	 * Stable list/reveal key. One minted URL per id: `${packageKodyId}/${name}`
	 * when unminted or the sole mint; `${packageKodyId}/${name}/${endpointId}`
	 * when several URLs share the declared name.
	 */
	id: string
	packageId: string
	packageKodyId: string
	packageName: string
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification: PackageWebhookVerification
	replay: PackageWebhookReplay
	challenge: PackageWebhookChallenge
	minted: boolean
	/** Minted endpoint id; null when this row is the unminted declaration. */
	endpointId: string | null
	/** Short user-set label when several URLs share this declared name. */
	instanceLabel: string | null
	handle: string | null
	urlHost: string | null
	enabled: boolean | null
	/** True once a person approved it (a live enablement exists). */
	approved: boolean
	/** Where to approve a minted webhook; null when unminted or approved. */
	approvalUrl: string | null
	/**
	 * False for mints that predate encrypted secret storage. The UI offers
	 * Rotate instead of Reveal for those, since the hash cannot rebuild the
	 * URL.
	 */
	urlRecoverable: boolean
	createdAt: string | null
	rotatedAt: string | null
	/** ISO timestamp while the previous URL still accepts deliveries after rotate. */
	previousUrlActiveUntil: string | null
}

/** `/account/webhooks.json`: every declared webhook across the owner's packages. */

export type ConnectWebhookApplyLoaderData =
	| {
			ok: true
			handle: string
			fingerprint: string
			packageId: string
			packageKodyId: string
			packageName: string
			webhookName: string
			destination: {
				method: string
				url: string
				headers: Array<{ name: string; value: string }>
				body: string
				secretName: string | null
				integration: string | null
				injectionSites: Array<string>
				auth: string
			}
			alreadyGranted: boolean
	  }
	| {
			ok: false
			error: string
			handle: string | null
			fingerprint: string | null
	  }

export type AccountWebhooksLoaderData = {
	ok: true
	username: string
	webhooks: Array<PackageWebhookListItem>
}

/** `/profiles/:username/packages/:kodyId/webhooks.json`: one package's webhooks. */
export type PackageWebhooksLoaderData = {
	ok: true
	username: string
	kodyId: string
	webhooks: Array<PackageWebhookListItem>
}

/** Owner-only reveal result attached to mint / rotate / reveal responses. */
export type PackageWebhookRevealedUrl = {
	id: string
	handle: string
	url: string
}

export type PackageWebhooksActionPayload = {
	ok: true
	revealed?: PackageWebhookRevealedUrl
	/**
	 * Set by mint / rotate while the webhook is not on for anyone: minting
	 * never turns it on, so link the person to Approve.
	 */
	approvalUrl?: string
}

export type PendingVerificationLoaderData = {
	ok: true
	email: string
	emailVerificationDelivery?: EmailVerificationDelivery | null
}

export type AccountIntegrationListItem = {
	name: string
	appSlug: string
	provider: string
	appLabel: string | null
	accountLabel: string | null
	/** Empty when a provider-family prefill could not agree on token URL. */
	tokenUrl: string
	apiBaseUrl?: string | null
	/**
	 * Omitted when a provider-family prefill could not agree on flow so the
	 * connect UI keeps the query/default flow instead of inventing one.
	 */
	flow?: 'pkce' | 'confidential' | 'device'
	usePkce?: boolean | null
	/** Empty when a provider-family prefill could not agree on client id. */
	clientId: string
	hasClientSecret?: boolean | null
	requiredHosts?: Array<string>
	tokenExchangeStyle?: 'form' | 'basic-json' | 'basic-form' | null
	deviceAuthorizationUrl?: string | null
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
	/**
	 * True when this connection (or prefill) uses a platform built-in OAuth
	 * app: the operator owns the client registration, the shared client secret
	 * stays server-side, and the connect UI skips the client-credentials setup
	 * step entirely.
	 */
	platform?: boolean
	/** Scope menu for platform apps: the superset an operator verified. */
	platformAllowedScopes?: Array<string>
	/** Relative serving path of the operator-uploaded provider logo. */
	platformLogoPath?: string | null
	/** Explicit user-uploaded OAuth app logo (beats catalog and favicon). */
	logoPath?: string | null
	/** Auto-fetched favicon (loses to an explicit upload or catalog mark). */
	autoLogoPath?: string | null
	/** Operator-curated provider mark (after upload, before favicon). */
	catalogLogoPath?: string | null
	/** Operator-authored provider note for platform apps (limitations, caveats). */
	platformDescription?: string | null
	createdAt: string
	updatedAt: string
	/** Omitted or `any` is execute plus every package. */
	usageMode?: 'any' | 'packages'
	allowedPackageIds?: Array<string>
	/** Last classified OAuth refresh outcome. Absent when the sign-in is healthy. */
	lastAuthFailure?: IntegrationAuthFailureView
}

type AccountOauthAppConnectionRef = {
	name: string
	accountLabel: string | null
}

/**
 * Shared OAuth app projection for the account UI. Includes sibling
 * connection refs only — never secret or token values.
 */
export type AccountOauthAppListItem = {
	slug: string
	provider: string
	label: string | null
	clientId: string
	hasClientSecret: boolean
	tokenUrl: string
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	apiBaseUrl: string | null
	flow: 'pkce' | 'confidential' | 'device'
	usePkce: boolean | null
	tokenExchangeStyle: 'form' | 'basic-json' | 'basic-form' | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	connectionCount: number
	connections: Array<AccountOauthAppConnectionRef>
	/**
	 * True when this row is a platform (built-in) app the user connected to,
	 * not a user-registered OAuth app.
	 */
	platform?: boolean
	/** Relative serving path of the operator-uploaded provider logo. */
	platformLogoPath?: string | null
	/** Explicit user-uploaded OAuth app logo (beats catalog and favicon). */
	logoPath?: string | null
	/** Auto-fetched favicon (loses to an explicit upload or catalog mark). */
	autoLogoPath?: string | null
	/** Operator-curated provider mark (after upload, before favicon). */
	catalogLogoPath?: string | null
	createdAt: string
	updatedAt: string
}

export type AccountIntegrationsLoaderData = {
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationListItem>
	apps: Array<AccountOauthAppListItem>
	savedPackages?: Array<{ id: string; kodyId: string }>
	approval?: {
		name: string
		packageId: string
		packageKodyId: string | null
		usageMode: 'any' | 'packages'
		alreadyGranted: boolean
	} | null
	/** Enabled + published built-ins the viewer has not connected yet. */
	platformCatalog?: Array<PlatformIntegrationCatalogItem>
}

/**
 * The connection currently stored under a requested name — enough for the
 * connect page to warn before an OAuth flow replaces it with a different app.
 */
export type ConnectOauthExistingConnection = {
	lane: 'user' | 'platform'
	appSlug: string
}

/**
 * /connect/oauth prefill for `?provider=` visits: the stored bring-your-own
 * record the page merges into its config. `provider` is the normalized key
 * the record was resolved for; null on callback visits, which restore config
 * from sessionStorage instead.
 */
export type ConnectOauthLoaderData = {
	ok: true
	provider: string | null
	integration: AccountIntegrationListItem | null
	/** Built-in connections use platform discovery links instead. */
	builtInAvailable?: boolean
	/** See {@link ConnectOauthExistingConnection}. */
	existingConnection?: ConnectOauthExistingConnection | null
	/** Whether the stored client-secret secret is available for this connection. */
	hasStoredClientSecret?: boolean
	/**
	 * Absolute redirect (callback) URI for this deployment — the page URL
	 * without query — so SSR can render the Redirect URI card before the
	 * browser can compute it from `window.location`.
	 */
	redirectUri?: string
	/**
	 * Signed-in bare `/connect/oauth` visits: saved connections that can
	 * start from `?provider=` alone, then published built-ins not yet
	 * connected. Omitted on provider/callback visits.
	 */
	chooser?: {
		options: Array<ConnectOauthChooserOption>
	}
}

type AccountMcpServerListItem = {
	id: string
	name: string
	url: string
	enabled: boolean
	state: string
	connected: boolean
	toolCount: number
	/** Kody consent page for a pending authorization, never the provider URL. */
	authUrl: string | null
	error: string | null
	hasRefreshToken: boolean
	tools: Array<string>
	createdAt: string
	updatedAt: string
	/** Auto-fetched registrable-domain favicon for the server URL. */
	autoLogoPath: string | null
	/** Operator-curated catalog mark (before favicon). */
	catalogLogoPath: string | null
	usageMode: 'any' | 'packages'
	allowedPackageIds: Array<string>
	/**
	 * Public id of the pre-registered OAuth client, or null. The client
	 * secret is never sent to the browser.
	 */
	oauthClientId: string | null
}

export type AccountMcpServersLoaderData = {
	ok: true
	email: string
	username: string
	/** Canonical origin Kody registers as the OAuth client_uri. */
	oauthClientOrigin: string
	/** Exact redirect URI remote authorization servers must allow. */
	oauthCallbackUrl: string
	/** HTTPS CIMD URL Kody presents as client_id, or null on http origins. */
	oauthClientMetadataUrl: string | null
	servers: Array<AccountMcpServerListItem>
	savedPackages: Array<{ id: string; kodyId: string }>
}

export type McpServerAuthorizeLoaderData = {
	ok: true
	orgSlug: string
	serverId: string
	serverName: string
	serverUrl: string
	/** The server's detail page, for Cancel and the not-pending state. */
	serverHref: string
	/** Null when the server is not waiting for approval. */
	pending: {
		authorizationServerHost: string
		clientMode: McpOAuthClientMode
		csrfToken: string
	} | null
	error: string | null
}

/**
 * Continue on the MCP server consent page. The CSP keeps `form-action` on
 * 'self', so the browser cannot follow a form redirect to the provider: the
 * page posts with fetch and navigates to `authorizationUrl` itself.
 */
export type McpServerAuthorizeContinueResponse =
	| { ok: true; authorizationUrl: string }
	| {
			ok: false
			error: string
			/** Fresh page data (a new form token) when the page can still be shown. */
			consent: McpServerAuthorizeLoaderData | null
	  }

export type AccountPackageListingAhead = {
	listingId: string
	listingName: string
	listingHref: string
	originCommit: string
	listingPinnedCommit: string
	listingPublishedAt: string | null
	prompt: string
	diffHref: string
}

export type AccountPackageForkAhead = {
	listingId: string
	listingName: string
	listingHref: string
	diffHref: string
}

export type AccountPackageListItem = {
	id: string
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	hasApp: boolean
	sourceId: string
	lockedAt: string | null
	createdAt: string
	updatedAt: string
	hidden: boolean
	/** Inverse of forkable: private packages are not community-forkable. */
	isPrivate: boolean
	/**
	 * When true, the hosted package app may be served on the public internet
	 * after capability approval. Independent of forkable/`isPrivate`.
	 */
	isInternetVisible: boolean
	hasCommunityListing: boolean
	/**
	 * True when an active community listing pin lags `publishedCommit`.
	 * Promote auto-syncs the listing; this is only true briefly while a
	 * best-effort sync or scheduled backfill catches up.
	 */
	listingNeedsRepublish: boolean
	listingAhead: AccountPackageListingAhead | null
	forkAhead: AccountPackageForkAhead | null
}

export type AccountPackageCommunityFork = {
	listingName: string | null
	adoptedAt: string | null
	adoptionNote: string | null
}

export type AccountPackageDetail = AccountPackageListItem & {
	searchText: string | null
	exports: Array<string> | null
	publishedCommit: string | null
	/**
	 * Default-branch HEAD when the owner can resolve the artifact source.
	 * Compared with `publishedCommit` to show whether a publish is pending.
	 * Null when there is no HEAD or the lookup failed — see
	 * `pendingCommitKnown`.
	 */
	pendingCommit: string | null
	/**
	 * False when the artifact HEAD lookup failed. Do not treat the package as
	 * up to date or demote Approve until this is true.
	 */
	pendingCommitKnown: boolean
	/**
	 * Author-supplied `package.json#version` on the package's published commit,
	 * when known. Display metadata only — not the community listing pin.
	 */
	publishedVersion: string | null
	/**
	 * Changed-file count between `publishedCommit` and `pendingCommit` when
	 * HEAD is ahead. Null when up to date, unknown, or the compare failed.
	 */
	unpublishedChangeCount: number | null
	/** True when the owning org is a personal org (not a team). */
	ownerIsPersonal: boolean
	/** Null for self-authored packages (no `community_forks` row). */
	communityFork: AccountPackageCommunityFork | null
	/**
	 * This UTC month's past-include credits for this package only (owner
	 * view). Always a row for owners (zero credits when nothing past include).
	 */
	creditAttribution?: CreditAttributionRow | null
}

type AccountPackagePublishDiffFile = {
	path: string
	status: 'added' | 'removed' | 'modified'
	patch: string | null
}

/** Catalog listing pin lags the package runtime published commit. */
export type AccountPackageListingBehindHint = {
	pinnedVersion: string | null
	promotedVersion: string | null
	behind: true
	updateHint: string
	updateUrl: string
}

export type AccountPackageApprovePublishLoaderData = {
	ok: true
	email: string
	package: {
		id: string
		name: string
		kodyId: string
		sourceId: string
		lockedAt: string | null
	}
	publishedCommit: string | null
	pendingCommit: string | null
	alreadyPublished: boolean
	/**
	 * True when `pendingCommit` is default-branch HEAD (no `?commit=` pin).
	 * False when the URL named a specific commit — alreadyPublished then means
	 * that pin matches the public version, not that HEAD has nothing pending.
	 */
	pendingIsDefaultHead: boolean
	filesHref: string
	packageHref: string
	/**
	 * Present only when an active community listing pin still lags after a
	 * promote (auto-sync failed). Owners rarely see this; the scheduled
	 * backfill retries.
	 */
	listing: AccountPackageListingBehindHint | null
	/**
	 * Always false after listing auto-follow: promote advances the catalog
	 * pin with the runtime. Kept for loader shape compatibility.
	 */
	listingWillLagAfterPromote: boolean
	/**
	 * Names stale static dependents that still read a kept `kody.secretMounts`
	 * alias, or that will break if this publish removes one. Null when there
	 * is nothing to warn about.
	 */
	secretMountCompatNotice: string | null
	/**
	 * Advance warning when this package fills a user credential whose
	 * allowed-packages list excludes it. Stricter enforcement starts
	 * Wednesday, Oct 21, 2026. Null when there is nothing to warn about.
	 */
	allowedPackagesPublishNotice: string | null
	diff: {
		files: Array<AccountPackagePublishDiffFile>
		omittedCount: number
	}
}

/** A publish waiting in the package's owner approval queue. */
export type AccountPackagePendingApproval = {
	id: string
	reason: 'credential_needs_changed' | 'went_public'
	reasonLabel: string
	pendingCommit: string
	createdAt: string
	/** One line per credential need the paused publish adds or reshapes. */
	changes: Array<string>
	/** The POST action that approves it. */
	approveAction: 'approve-credential-needs' | 'approve-went-public'
}

export type AccountPackageApproveCapabilitiesLoaderData = {
	ok: true
	pendingApprovals: Array<AccountPackagePendingApproval>
	/**
	 * Pending `went_public` request folded into the main Approve
	 * (`approve-capabilities-and-go-public`). Set whenever the package is not
	 * yet internet-visible and a went_public request is waiting — including
	 * when the capability set is already approved.
	 */
	goPublicRequestId: string | null
	email: string
	package: {
		id: string
		name: string
		kodyId: string
		sourceId: string
		hasApp: boolean
		isInternetVisible: boolean
	}
	publishedCommit: string | null
	fingerprint: string
	entries: Array<{
		kind: 'credential' | 'storage'
		credentialId?: string
		name?: string
		/** How the package reaches the credential: need, mount, grant, or package. */
		source?: 'need' | 'mount' | 'grant' | 'package'
		/** The declared `kody.credentials` key a `need` credential fills. */
		needKey?: string
		/** Visitors of the internet-visible app may use this credential. */
		ownerCredentialForVisitors?: true
		credentialKind?: string
		hosts: Array<string>
		placement?: string | null
		via: Array<string>
		storageId?: string
	}>
	fingerprintMatchesApproval: boolean
	latestApprovedAt: string | null
	securityAudit: AccountPackageSecurityAudit
	settingsHref: string
	packageHref: string
	approveHref: string
}

/**
 * Security audit for the current published commit + capability fingerprint.
 * Informational only: it never approves anything.
 */
export type AccountPackageSecurityAudit =
	| { status: 'unpublished' }
	| { status: 'not_audited'; prompt: string }
	| {
			status: 'audited'
			verdict: 'pass' | 'concerns'
			summary: string
			/** Agent or person named by the recorder, else the recorder. */
			auditor: string
			/** `@username` that recorded it, when different from `auditor`. */
			recordedBy: string | null
			recordedAt: string
	  }

export type AccountPackagesSort = 'updated' | 'created' | 'name'

export type AccountPackagesAppFilter = 'all' | 'with' | 'without'

export type AccountPackagesLoaderData = {
	ok: true
	email: string
	username: string
	invocationUrlOrigin: string
	packages: Array<AccountPackageListItem>
	selectedPackage: AccountPackageDetail | null
	page: number
	pageSize: number
	total: number
	query: string
	appFilter: AccountPackagesAppFilter
	sort: AccountPackagesSort
}

export type AccountSecretListItem = {
	id: string
	name: string
	scope: 'package' | 'user'
	description: string
	packageId: string | null
	packageTitle: string | null
	allowedHosts: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
	ttlMs: number | null
}

export type AccountSecretDetail = AccountSecretListItem & {
	value: string
}

type AccountSecretProviderBindingItem = {
	provider: string
	packageId: string
	kodyId: string
	doorSecretName: string
	config: Record<string, string>
	updatedAt: string
}

type AccountSecretProviderApproval = {
	provider: string
	canonicalRef: string
	packageId: string
	kodyId: string
	alreadyGranted: boolean
	error?: string
}

type AccountSecretProviderGrantItem = {
	provider: string
	canonicalRef: string
	packageId: string
	kodyId: string
	createdAt: string
}

export type AccountSecretProvidersLoaderData = {
	ok: true
	email: string
	bindings: Array<AccountSecretProviderBindingItem>
	grants: Array<AccountSecretProviderGrantItem>
	packages: Array<{
		id: string
		kodyId: string
		name: string
	}>
	doorSecrets: Array<string>
	approval: AccountSecretProviderApproval | null
}

export type AccountSecretsLoaderData = {
	ok: true
	email: string
	packageOptions: Array<{
		id: string
		title: string
		updatedAt: string
	}>
	packages: Array<{
		id: string
		kodyId: string
		name: string
	}>
	secrets: Array<AccountSecretListItem>
	selectedSecret: AccountSecretDetail | null
	approval: {
		name: string
		names: Array<string>
		scope: 'package' | 'session' | 'user'
		requestedHost: string
		requestedHosts: Array<string>
		rejectedHosts: Array<{
			host: string
			reason: 'malformed' | 'unknown_suffix'
			message: string
		}>
		requestedPackageId: string | null
		currentAllowedHosts: Array<string>
		currentAllowedPackages: Array<string>
	} | null
	approvalError: string | null
	/**
	 * Set when the secret value/access writes committed but linking the Key to
	 * a credential provider failed. Callers must not treat this as a failed
	 * save (retrying create would 409).
	 */
	providerLinkError?: string | null
	/**
	 * Set when the secret saved under a new name but deleting the prior secret
	 * failed. Callers must not treat this as a failed save.
	 */
	renameCleanupError?: string | null
}

/**
 * JSON-safe blob for job params (and similar free-form payloads). Remix
 * entry props require SerializableValue; `unknown` is not allowed.
 */
type AccountLoaderJsonValue =
	| string
	| number
	| boolean
	| null
	| Array<AccountLoaderJsonValue>
	| { [key: string]: AccountLoaderJsonValue }

type AccountJobSchedule =
	| { type: 'once'; runAt: string }
	| { type: 'interval'; every: string }
	| { type: 'cron'; expression: string }

export type AccountJobListItem = {
	id: string
	name: string
	packageId: string
	packageName: string | null
	packageKodyId: string | null
	scheduleSummary: string
	scheduleType: AccountJobSchedule['type']
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	expiresAt: string | null
	expired: boolean
	dueNow: boolean
	lastRunStatus: 'success' | 'error' | null
	nextRunAt: string
	lastRunAt: string | null
	runCount: number
	successCount: number
	errorCount: number
}

type AccountJobRecentRun = {
	id: string
	startedAt: string
	finishedAt: string
	status: 'success' | 'error' | 'running'
	durationMs: number
	error: string | null
}

export type AccountJobDetail = AccountJobListItem & {
	params: { [key: string]: AccountLoaderJsonValue } | null
	paramsHighlighted?: HighlightedCode
	schedule: AccountJobSchedule
	lastRunError: string | null
	lastDurationMs: number | null
	recentRuns: Array<AccountJobRecentRun>
	storageId: string
	sourceId: string
	publishedCommit: string | null
	createdAt: string
	updatedAt: string
}

type AccountJobsAlarm = {
	bindingAvailable: boolean
	status: string
	storedUserId: string | null
	alarmScheduledFor: string | null
	nextRunnableJobId: string | null
	nextRunnableRunAt: string | null
	alarmInSync: boolean | null
}

export type AccountJobsLoaderData = {
	ok: true
	username: string
	jobs: Array<AccountJobListItem>
	selectedJob: AccountJobDetail | null
	selectedJobId: string | null
	alarm?: AccountJobsAlarm
}

type AccountWorkflowSourceType = 'package' | 'inline'

export type AccountWorkflowRunStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'waiting'
	| 'waitingForPause'
	| 'unknown'
	| 'complete'
	| 'errored'
	| 'terminated'
	| 'cancelled'

export type AccountWorkflowListItem = {
	id: string
	sourceType: AccountWorkflowSourceType
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	workflowName: string
	exportName: string | null
	idempotencyKey: string
	runAt: string
	planDate: string | null
	status: AccountWorkflowRunStatus | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	lastError: string | null
}

type AccountWorkflowDetail = AccountWorkflowListItem

export type AccountWorkflowsLoaderData = {
	ok: true
	username: string
	workflows: Array<AccountWorkflowListItem>
	selectedWorkflow: AccountWorkflowDetail | null
	selectedWorkflowId: string | null
}

export type AccountActivityRunListItem = {
	id: string
	surface: Exclude<AccountActivitySurfaceFilter, 'all'>
	status: 'running' | 'success' | 'error'
	name: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	errorTriage: 'ignored' | 'resolved' | null
	packageId: string | null
	jobId: string | null
	logCount: number
	idempotencyKey: string | null
	/** Execute-only: `invoke` | `code` from run metadata (forward-only). */
	entry: 'invoke' | 'code' | null
	/** Stable LOADER worker id (UWD graph identity) from run metadata. */
	workerId: string | null
}

type AccountActivityRunLog = {
	sequence: number
	level: 'debug' | 'info' | 'log' | 'warn' | 'error'
	message: string
	fields: { [key: string]: AccountLoaderJsonValue } | null
}

export type AccountActivityRunDetail = AccountActivityRunListItem & {
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	parentRunId: string | null
	triageNote: string | null
	triagedAt: string | null
	triagedBy: string | null
	metadata: { [key: string]: AccountLoaderJsonValue }
	metadataHighlighted?: HighlightedCode
	logs: Array<AccountActivityRunLog>
}

type AccountActivitySummary = {
	since: string
	total: number
	errors: number
	ignored: number
	resolved: number
	running: number
}

type AccountActivityLoaderData = {
	ok: true
	viewFilter: AccountActivityViewFilter
	statusFilter: AccountActivityStatusFilter
	surfaceFilter: AccountActivitySurfaceFilter
	triageFilter: AccountActivityTriageFilter
	summary: AccountActivitySummary
	runs: Array<AccountActivityRunListItem>
	nextCursor: string | null
	selectedRun: AccountActivityRunDetail | null
	selectedRunId: string | null
	retentionDays: number
}

type AccountMemoryStatus = 'active' | 'archived' | 'deleted'

export type AccountMemoryListItem = {
	id: string
	subject: string
	category: string | null
	status: AccountMemoryStatus
	tags: Array<string>
	summary: string
	updatedAt: string
}

type AccountMemoryDetail = AccountMemoryListItem & {
	details: string
	sourceUris: Array<string>
	dedupeKey: string | null
	createdAt: string
	lastAccessedAt: string | null
	deletedAt: string | null
}

export type AccountMemoriesLoaderData = {
	ok: true
	email: string
	username: string
	memories: Array<AccountMemoryListItem>
	selectedMemory: AccountMemoryDetail | null
	query: string
	includeDeleted: boolean
	/**
	 * Team-org legacy list: read-only until cleanup. Personal org is writable.
	 * Memory is personal-only (ADR 0072).
	 */
	legacyReadOnly: boolean
}

type AccountEmailUsageEntry = {
	count: number
	limit: number
}

type AccountEmailUsage = {
	plan: AdminPlanName
	day: string
	stored_messages: AccountEmailUsageEntry
	sends_today: AccountEmailUsageEntry
	receives_today: AccountEmailUsageEntry
	max_message_bytes: number
}

type AccountEmailInboxAddress = {
	id: string
	address: string
	enabled: boolean
	created_at: string
}

type AccountEmailInbox = {
	id: string
	name: string
	description: string
	enabled: boolean
	addresses: Array<AccountEmailInboxAddress>
	created_at: string
	updated_at: string
}

type AccountEmailSenderClassification =
	| 'member'
	| 'authenticated'
	| 'unverified'

type AccountEmailEnableSender = {
	sender: { kind: 'member' | 'address'; value: string }
	topic: 'email.message.received' | 'email.message.quarantined'
	org_slug: string
	packages_href: string
	packages: Array<{ kody_id: string }>
}

export type AccountEmailMessageListItem = {
	id: string
	direction: 'inbound' | 'outbound'
	inbox_id: string | null
	thread_id: string | null
	from_address: string | null
	envelope_from: string | null
	to_addresses: Array<string>
	subject: string | null
	message_id_header: string | null
	processing_status: string
	classification: 'accepted' | 'quarantined'
	classification_reason: string | null
	sender_classification: AccountEmailSenderClassification | null
	sender_classification_reason: string | null
	provider_message_id: string | null
	delivery_status: string | null
	delivery_status_at: string | null
	error: string | null
	received_at: string | null
	sent_at: string | null
	created_at: string
	updated_at: string
}

type AccountEmailAttachment = {
	id: string
	filename: string | null
	content_type: string | null
	content_id: string | null
	disposition: string | null
	size: number | null
	storage_kind: string
	storage_key: string | null
	created_at: string
}

type AccountEmailDeliveryEvent = {
	id: string
	event_type: string
	provider: string | null
	provider_message_id: string | null
	provider_event_id: string | null
	detail_json: string
	created_at: string
}

export type AccountEmailMessageDetail = AccountEmailMessageListItem & {
	cc_addresses: Array<string>
	bcc_addresses: Array<string>
	reply_to_addresses: Array<string>
	in_reply_to_header: string | null
	references: Array<string>
	headers: { [key: string]: AccountLoaderJsonValue } | null
	auth_results: string | null
	text_body: string | null
	html_body: string | null
	raw_size: number | null
	attachments: Array<AccountEmailAttachment>
	delivery_events: Array<AccountEmailDeliveryEvent>
	enable_sender: AccountEmailEnableSender | null
}

export type AccountEmailLoaderData = {
	ok: true
	emailVerified: boolean
	email: string
	username: string
	inboxAddress: string | null
	verificationMessage: string | null
	/**
	 * Owner-clearable pause after consecutive outbound delivery failures.
	 * Distinct from the admin abuse pause.
	 */
	outboundDeliveryPausedAt: string | null
	inboxes: Array<AccountEmailInbox>
	messages: Array<AccountEmailMessageListItem>
	selectedMessage: AccountEmailMessageDetail | null
	usage: AccountEmailUsage | null
	page: number
	pageSize: number
	total: number
	query: string
	/** `null` means no classification filter (all messages). */
	classification: 'accepted' | 'quarantined' | null
}

export type AuthProvidersLoaderData = {
	ok: true
	providers: Array<{ id: string; label: string }>
	turnstileSiteKey: string | null
}

export type OAuthAuthorizeConsentOrg = {
	slug: string
	displayName: string | null
	role: string | null
}

export type OAuthAuthorizeLoaderData =
	| {
			ok: true
			client: { id: string; name: string }
			scopes: Array<string>
			emailVerified: boolean | null
			/** When true, authorize UI must collect credentials (prompt=login / max_age). */
			requireCredentials: boolean
			orgs: Array<OAuthAuthorizeConsentOrg>
			/** From `?org=`, the sole accessible org, or null when multi and unspecified. */
			selectedOrgSlug: string | null
	  }
	| {
			ok: false
			error: string
			allowClientReset: boolean
			code?: 'email_verification_required'
	  }

/** Hosted package-app OAuth consent on `/oauth/package-app/authorize`. */
export type PackageAppOauthConsentLoaderData = {
	ok: true
	packageName: string
	iconUrl: string | null
	publisherDisplayName: string
	publisherUsername: string
	appDomain: string | null
	viewerDisplayName: string
	clientId: string
	kodyId: string
	redirectUri: string
	scopes: Array<string>
	claimLabels: Array<string>
	hiddenFields: Record<string, string>
}

export type DiscordPageLoaderData = {
	ok: true
	signedIn: boolean
	discordConnected: boolean
	discordDisplayName: string | null
	discordProviderAvailable: boolean
	canSyncDiscordRoles: boolean
	inviteUrl: string
	turnstileSiteKey: string | null
}

export type AppLoaderData = {
	blog?: BlogLoaderData
	blogPost?: BlogPostLoaderData
	docsConnect?: DocsConnectLoaderData
	docDetail?: DocDetailLoaderData
	communityDetailShell?:
		| CommunityDetailShellLoaderData
		| CommunityPackageUnauthorizedLoaderData
		| CommunityPackageNotFoundLoaderData
		| CommunityPackageNoAccessLoaderData
	packageFiles?: PackageFilesLoaderData
	profileShell?: ProfileShellLoaderData | ProfileUnavailableLoaderData
	profileList?: ProfileListLoaderData
	adminUsers?: AdminUsersLoaderData
	adminRoles?: AdminRolesLoaderData
	adminCommunityReports?: AdminCommunityReportsLoaderData
	adminReservedUsernames?: AdminReservedUsernamesLoaderData
	adminFeatureFlags?: AdminFeatureFlagsLoaderData
	youtubeWatch?: YoutubeWatchLoaderData
	landingHeroVideos?: Array<LandingHeroVideo>
	adminPlatformIntegrations?: AdminPlatformIntegrationsLoaderData
	adminProviderMarks?: AdminProviderMarksLoaderData
	adminCodemods?: AdminCodemodsLoaderData
	adminInsights?: AdminInsightsLoaderData
	adminPlatformFeedback?: AdminPlatformFeedbackLoaderData
	adminSystemEmail?: AdminSystemEmailLoaderData
	accountProfile?: AccountProfileLoaderData
	accountOrganizations?: AccountOrganizationsLoaderData
	accountOrganizationsNew?: AccountOrganizationsNewLoaderData
	orgSettings?: OrgSettingsLoaderData
	orgMembers?: OrgMembersLoaderData
	orgInviteJoin?: OrgInviteJoinLoaderData
	orgTeams?: OrgTeamsLoaderData
	orgGrants?: OrgGrantsLoaderData
	orgCollaborators?: OrgCollaboratorsLoaderData
	accountConnections?: AccountConnectionsLoaderData
	accountEmailDestinations?: AccountEmailDestinationsLoaderData
	accountConnectedAgents?: AccountConnectedAgentsLoaderData
	accountConnectionUsage?: AccountConnectionUsageLoaderData
	accountWebhooks?: AccountWebhooksLoaderData
	connectWebhookApply?: ConnectWebhookApplyLoaderData
	onboarding?: OnboardingLoaderData
	connectOauth?: ConnectOauthLoaderData
	pendingVerification?: PendingVerificationLoaderData
	accountTwoFactor?: AccountTwoFactorLoaderData
	accountPasskeys?: AccountPasskeysLoaderData
	accountMcpOauthClients?: AccountMcpOauthClientsLoaderData
	accountIntegrations?: AccountIntegrationsLoaderData
	accountMcpServers?: AccountMcpServersLoaderData
	mcpServerAuthorize?: McpServerAuthorizeLoaderData
	accountPackages?: AccountPackagesLoaderData
	accountPackageApprovePublish?: AccountPackageApprovePublishLoaderData
	accountPackageApproveCapabilities?: AccountPackageApproveCapabilitiesLoaderData
	accountCredentials?: AccountCredentialsResponse
	packageCredentials?: PackageCredentialsLoaderData
	packageCollaborators?: PackageCollaboratorsLoaderData
	packageCredentialApproval?: PackageCredentialApprovalLoaderData
	approvalBundle?: ApprovalBundleLoaderData
	accountSecrets?: AccountSecretsLoaderData
	accountSecretProviders?: AccountSecretProvidersLoaderData
	accountJobs?: AccountJobsLoaderData
	accountWorkflows?: AccountWorkflowsLoaderData
	accountActivity?: AccountActivityLoaderData
	accountMemories?: AccountMemoriesLoaderData
	accountEmail?: AccountEmailLoaderData
	authProviders?: AuthProvidersLoaderData
	oauthAuthorize?: OAuthAuthorizeLoaderData
	packageAppOauthConsent?: PackageAppOauthConsentLoaderData
	accountBilling?: AccountBillingLoaderData
	accountBillingSuccess?: AccountBillingSuccessLoaderData
	accountUsage?: AccountUsageLoaderData
	orgCredits?: OrgCreditsLoaderData
	accountWaiting?: AccountWaitingLoaderData
	orgFollows?: OrgFollowsLoaderData
	accountExperiments?: AccountExperimentsLoaderData
	discord?: DiscordPageLoaderData
	walkthroughHosts?: WalkthroughHostPick
	/** Homepage agent marquee: one SSR shuffle of `withAgents` slugs. */
	landingAgentOrder?: Array<string>
	onboardingAgentChooser?: OnboardingAgentChooserPick
}

type AccountBillingOrg = {
	slug: string
	/** Null for the signup organization, which shows the person's own name. */
	displayName: string | null
	personal: boolean
	/** Owners and members: the Pro quantity checkout charges for. */
	seats: number
}

export type AccountBillingLoaderData = {
	ok: true
	configured: boolean
	manualPlan: AdminPlanName
	stripePlan: AdminPlanName | null
	/**
	 * Billing interval of the active Stripe subscription when it uses a
	 * configured price; null when unknown (retired price, no refresh).
	 */
	stripeInterval: 'month' | 'year' | null
	effectivePlan: AdminPlanName
	hasStripeCustomer: boolean
	cancelAt: string | null
	/** Stripe subscription status from on-page refresh; null if unknown/unavailable. */
	subscriptionStatus: string | null
	purchasablePlans: Array<'pro'>
	/** Stripe subscription uses the purchasable Pro price (credit wallet). */
	creditsEligible: boolean
	/** Deep link to the Credits section of the usage page; null off the signup org. */
	creditsHref: string | null
	/** Account usage page (limits / consumption); null off the signup org. */
	usageHref: string | null
	referralProgram: ReferralProgramSummary | null
	org: AccountBillingOrg
	error?: string
	/** Success notice mapped from `?billing=<code>` (e.g. a completed plan change). */
	notice?: string
}

export type AccountCreditsLimit = {
	resource: string
	label: string
	/** Included with the Pro subscription. */
	included: number
	/** How far credits can carry usage past the include. */
	creditsCeiling: number
}

export type AccountCreditsLedgerItem = {
	id: string
	kind: 'top_up' | 'auto_refill' | 'admin_grant' | 'debit'
	amountMicroUsd: number
	description: string
	createdAt: string
}

/** One row of the organization credit ledger on `/@slug/-/credits`. */
export type OrgCreditsLedgerEntry = {
	id: string
	kind: AccountCreditsLedgerItem['kind']
	/** Purchase, Auto-refill, Grant, or Usage. */
	typeLabel: string
	description: string
	/** What the row paid for or where it came from; null when nothing to add. */
	detail: string | null
	amountMicroUsd: number
	/** Wallet balance right after this row (ledger rows explain every change). */
	balanceAfterMicroUsd: number
	createdAt: string
}

export type OrgCreditsLedgerPage = {
	entries: Array<OrgCreditsLedgerEntry>
	/** Pass as `?cursor=` to `/@slug/-/credits.json` for older rows. */
	nextCursor: string | null
}

/** A monthly spend budget and what it has used this UTC month. */
export type OrgCreditsBudget = {
	budgetMicroUsd: number
	/** Null when the spend counter could not be read right now. */
	spentMicroUsd: number | null
}

export type OrgCreditsBudgets = {
	/** UTC month the spend counters cover (`YYYY-MM`). */
	month: string
	/**
	 * The viewer's own monthly budget in this organization. `individual` is a
	 * budget set for them; `orgDefault` is the organization default. Null when
	 * no budget applies.
	 */
	yours: (OrgCreditsBudget & { source: 'individual' | 'orgDefault' }) | null
	/** Organization-wide settings. Only for owners and billing admins. */
	org: {
		defaultUserBudgetMicroUsd: number | null
		automation: OrgCreditsBudget | null
	} | null
}

export type OrgCreditsLoaderData = {
	ok: true
	org: { slug: string; displayName: string | null; personal: boolean }
	/** `billing` sees balance and ledger; `member` sees only their budget. */
	access: 'billing' | 'member'
	/** Null for members without `billing:read`. */
	wallet: {
		balanceMicroUsd: number
		/** Usage past the include draws on credits (purchasable Pro wallet). */
		creditsEligible: boolean
		autoRefillEnabled: boolean
		/** Usage page Credits section: top-ups and auto-refill settings. */
		manageHref: string
		/** Usage page breakdown of what spent credits this month. */
		whereItWentHref: string
	} | null
	budgets: OrgCreditsBudgets
	ledger: OrgCreditsLedgerPage | null
}

/**
 * One credit-debit meter in the usage page's Credits section (rate card +
 * this-period usage). Same meter path as included compute. Customer labels
 * only (Worker compute / Rows read) — never UWD / Max jargon.
 */
export type AccountCreditsDebitMeter = {
	meter: string
	label: string
	/** Published unit rate from `creditDebitRates`. */
	unitRateLabel: string
	/** Monthly include for the account's plan / wallet state. */
	include: number
	/** Usage this UTC month. */
	used: number
	/** Units past the include (billable when the wallet is funded). */
	pastInclude: number
	/** `used / include` (same as usage-page meter percent). */
	percentOfInclude: number
	/** Estimated credits for `pastInclude` at the published rate. */
	estCreditsMicroUsd: number
}

/**
 * Activity, included compute, and the credits alarm on `/account/usage`.
 * The entitlement-warning emails share the same presentation helpers.
 */
export type AccountUsageStoryData = {
	/** This UTC month's code executions and runs (the primary busy signal). */
	activity: AccountActivity
	/** Worker compute + Rows read vs the monthly include, ready to render. */
	includedCompute: Array<IncludedComputeMeter>
	includedComputeSummary: string
	/** Set only when the wallet or access is actually at risk. */
	creditsAlarm: CreditsAlarm | null
}

/**
 * Credits spent this period attributed to packages (and Ad hoc). Loaded with
 * `/account/usage`; package pages reuse the same breakdown shape.
 */

/**
 * Credits section of `/account/usage`. Without a wallet (Free, retired
 * Standard/Pro, gift/referral overlays, manual grants) it is only the
 * switch-to-Pro prompt: no balance, no purchase UI.
 */
export type AccountUsageCredits =
	| {
			eligible: false
			/** Checkout for the purchasable Pro is configured. */
			canSwitchToPro: boolean
			billingHref: string
	  }
	| AccountUsageCreditsWallet

export type AccountUsageCreditsWallet = {
	/** Purchasable Pro (or admin-eligible Pro) with the credit wallet. */
	eligible: true
	configured: boolean
	/** Checkout for the purchasable Pro is configured. */
	canSwitchToPro: boolean
	/**
	 * Subscribed on the purchasable Pro price with a Stripe customer, on a
	 * deployment with billing configured.
	 */
	canBuyCredits: boolean
	balanceMicroUsd: number
	/**
	 * Eligible wallet with credits left: usage past the include runs on
	 * credits. False means usage past the include stops.
	 */
	hasCredits: boolean
	packsCents: Array<number>
	customMinCents: number
	customMaxCents: number
	autoRefill: {
		enabled: boolean
		thresholdCents: number | null
		amountCents: number | null
		monthlyCapCents: number | null
		minThresholdCents: number
		refilledThisMonthCents: number
		/** A top-up saved a card for off-session refills. */
		hasPaymentMethod: boolean
	}
	notify: {
		autoRefilled: boolean
		monthlyCap: boolean
		lowBalance: boolean
	}
	limits: Array<AccountCreditsLimit>
	/** Worker compute + Rows read rate card and this-period usage. */
	debitMeters: Array<AccountCreditsDebitMeter>
	recent: Array<AccountCreditsLedgerItem>
}

export type AccountBillingSuccessLoaderData = {
	ok: true
	needsOnboarding: boolean
}

export type AccountUsageWeekWindow = {
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
}

export type AccountUsageEntitlementConsumption = {
	resource: string
	label: string
	group: 'daily' | 'counts' | 'storage' | 'limits' | 'monthly'
	kind: 'counter' | 'per_unit_max'
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
	week?: AccountUsageWeekWindow
}

type AccountUsageComputeMeter = {
	resource: ComputeOverageWarningResource
	label: string
	whatCounts: string
	howToReduce: string
	current: number
	include: number
	percentOfLimit: number
	overEightyPercent: boolean
	creditsStatus: ComputeIncludeCreditsStatus
}

export type AccountUsageComputeOverage = {
	meters: Array<AccountUsageComputeMeter>
	creditWallet: CreditWalletState
	/** Past-include state across both meters (worst meter wins). */
	creditsStatus: ComputeIncludeCreditsStatus
	/** This month's above-include usage at credit debit rates. */
	creditsCostMicroUsd: number
}

export type AccountUsageLoaderData = AccountUsageStoryData & {
	ok: true
	plan: AdminPlanName
	manualPlan: AdminPlanName
	stripePlan: AdminPlanName | null
	today: string
	weekStart: string
	entitlementConsumption: Array<AccountUsageEntitlementConsumption>
	warnings: Array<AccountUsageEntitlementConsumption>
	computeOverage: AccountUsageComputeOverage
	/** True only for the purchasable Pro with a Stripe customer. */
	canBuyCredits: boolean
	/**
	 * Past-include credits by package (and Ad hoc). Directly under the period
	 * credit total on `/account/usage`.
	 */
	whereItWent: CreditAttributionBreakdown
	/** Null for operator plans, which have no credits story. */
	credits: AccountUsageCredits | null
	/** Credits outcome (top-up added, settings saved) shown in that section. */
	notice?: string
	error?: string
}

export type AccountWaitingLoaderData = {
	ok: true
	items: Array<WaitingItem>
	/** Invites to accept or decline, shown above the other items. */
	invites: Array<AccountPendingInvite>
}

export type AccountExperimentsLoaderData = {
	ok: true
	experimentsOptIn: boolean
}
