/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { type CSSObject } from '@emotion/react'
import { useEffect } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { renderIcon } from '../components/icon.tsx'
import { docHref } from '#universal/docs-nav.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	typography,
} from '#universal/styles/tokens.ts'

type EntityExplainerLink = {
	href: string
	label: string
}

export type EntityExplainerCopy = {
	id: string
	question: string
	paragraphs: ReadonlyArray<string>
	learnMore?: ReadonlyArray<EntityExplainerLink>
}

const packagesIntegrationsMcpGuide = {
	href: docHref('packages-integrations-mcp'),
	label: 'Packages, integrations, and MCP servers',
} as const satisfies EntityExplainerLink

const entityExplainerDefinitions = [
	{
		id: 'overview',
		question: 'What is this overview?',
		paragraphs: [
			'Overview brings together this workspace’s recent runs, repositories, and upcoming jobs.',
		],
		learnMore: [{ href: docHref('organizations'), label: 'Organizations' }],
	},
	{
		id: 'repositories',
		question: 'What is a repository?',
		paragraphs: [
			'A repository is the git home for code in this workspace. This page lists plain repositories and packages. A package is a repository with a Kody package manifest; the API and CLI still call that entity package (for example packageList and packageSave).',
		],
		learnMore: [
			{ href: docHref('package-authoring'), label: 'Package authoring' },
			{ href: docHref('package-lifecycle'), label: 'Package lifecycle' },
		],
	},
	{
		id: 'follows',
		question: 'What are follows?',
		paragraphs: [
			'Follows track packages and repositories so this workspace can receive new versions and push events.',
		],
		learnMore: [
			{
				href: docHref('package-subscriptions'),
				label: 'Subscriptions and events',
			},
		],
	},
	{
		id: 'settings',
		question: 'What are organization settings?',
		paragraphs: [
			'Settings control this organization’s identity, profile, and custom domains.',
		],
		learnMore: [{ href: docHref('organizations'), label: 'Organizations' }],
	},
	{
		id: 'members',
		question: 'What is a member?',
		paragraphs: [
			'A member belongs to this organization with an Owner, Member, or Billing role. Grants control access to individual resources.',
		],
		learnMore: [{ href: docHref('organizations'), label: 'Organizations' }],
	},
	{
		id: 'teams',
		question: 'What is a team?',
		paragraphs: [
			'A team groups organization members so you can grant them access to resources together.',
		],
		learnMore: [
			{ href: docHref('package-sharing'), label: 'Sharing and grants' },
		],
	},
	{
		id: 'grants',
		question: 'What is a grant?',
		paragraphs: [
			'A grant gives a person or team permission to use or manage specific resources in this workspace.',
		],
		learnMore: [
			{ href: docHref('package-sharing'), label: 'Sharing and grants' },
		],
	},
	{
		id: 'collaborators',
		question: 'What is an outside collaborator?',
		paragraphs: [
			'An outside collaborator has access to shared resources without joining the organization as a member.',
		],
		learnMore: [
			{ href: docHref('package-sharing'), label: 'Sharing and grants' },
		],
	},
	{
		id: 'billing',
		question: 'What is billing?',
		paragraphs: [
			'Billing manages this organization’s plan, paid seats, payment method, and invoices.',
		],
		learnMore: [
			{ href: docHref('organizations'), label: 'Organizations and paid seats' },
		],
	},
	{
		id: 'secret-providers',
		question: 'What is a secret provider?',
		paragraphs: [
			'A secret provider connects Kody to an external vault, so packages can use stored credentials without exposing their values.',
		],
		learnMore: [
			{ href: docHref('secret-providers'), label: 'Custom secret providers' },
		],
	},
	{
		id: 'mcp-oauth-clients',
		question: 'What is an MCP OAuth client?',
		paragraphs: [
			'An MCP OAuth client identifies an agent host connecting to Kody. Pre-register one when the host cannot register itself.',
		],
		learnMore: [
			{ href: docHref('connect-your-agent'), label: 'Connect your agent' },
		],
	},

	{
		id: 'email',
		question: 'What is email?',
		paragraphs: [
			"Every Kody account gets a personal inbox at your username on this deployment's email domain. Inbound mail is stored so automations can react to it, and your agent can send you notify-self messages or reply to stored threads.",
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'jobs',
		question: 'What is a job?',
		paragraphs: [
			'A job is scheduled work that runs in the cloud on Cloudflare Workers, whether or not your computer is on. Package-owned jobs live with the saved package that declares them.',
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'execution-contexts',
		question: 'What is an execution context?',
		paragraphs: [
			"An execution context is a machine you registered with the Kody CLI daemon, such as your laptop or a build server. When one is in your fallback chain, execute runs there instead of on Kody cloud, so runs can reach that machine's files and local network.",
			'A new context is used by no one until someone adds it to a chain. Its operator can share it with specific people, a team, or everyone in an organization, and each of them opts in first, because the operator can see the code, inputs, logs and results of runs on it. Credential values stay on Kody.',
			'Kody tries your chain in order and moves on when a context is offline or busy. Kody cloud stays last unless you remove it. Context runs do not count toward plan quotas, and agents use the same contexts and chain through the API.',
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'profiles',
		question: 'What is an agent profile?',
		paragraphs: [
			'An agent profile is a scoped identity you create for an agent or bot you run, in one organization. It is not your public profile. A request made as a profile reaches only what you, the profile, and every profile above it allow.',
			'A profile starts with a snapshot of grants, each one a subset of what you hold. It does not inherit access you or its parent gain later; only an explicit share adds more. Sub-profiles nest up to five levels and can only narrow what their parent holds.',
			'Expiry only moves earlier, and a sub-profile never outlives its parents. Revoking a profile is final and stops every sub-profile below it. Profile-bound tokens let an agent act as one profile.',
		],
		learnMore: [
			{
				href: docHref('profiles'),
				label: 'Profiles',
			},
		],
	},
	{
		id: 'workflows',
		question: 'What is a workflow?',
		paragraphs: [
			'A workflow is one-shot durable work, not a recurring schedule. Inline workflows carry their code; package workflows call a published export.',
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'webhooks',
		question: 'What is a webhook?',
		paragraphs: [
			'A webhook is an inbound HTTP endpoint a package declares. The minted URL is a credential: when a provider POSTs to it, Kody runs that package’s export.',
		],
		learnMore: [
			{
				href: docHref('triggers'),
				label: 'Jobs, workflows, and webhooks',
			},
		],
	},
	{
		id: 'credentials',
		question: 'What is a credential?',
		paragraphs: [
			'A credential is anything Kody uses to reach a service for you: a key (an API key or token), an OAuth connection, an MCP server, a login, a URL secret, a signing key, or a vault. Agents and packages name the credential; Kody places its value at the network boundary and never returns it.',
		],
		learnMore: [
			{ href: docHref('secrets'), label: 'Secrets' },
			packagesIntegrationsMcpGuide,
		],
	},
	{
		id: 'secrets',
		question: 'What is a secret?',
		paragraphs: [
			'A secret is a credential Kody stores for you — an API key or token. Your agent references it by name; Kody substitutes the value at the network boundary and never returns it to chat.',
		],
		learnMore: [
			{
				href: docHref('account-secret-setup'),
				label: 'Secret setup guide',
			},
		],
	},
	{
		id: 'integrations',
		question: 'What is an integration?',
		paragraphs: [
			'An integration is a connected service — usually OAuth — so Kody can act as you on that provider. The connection is yours: packages use it, they do not own it.',
		],
		learnMore: [
			packagesIntegrationsMcpGuide,
			{
				href: docHref('integration-bootstrap'),
				label: 'Integration bootstrap guide',
			},
		],
	},
	{
		id: 'connections',
		question: 'What is a connected agent?',
		paragraphs: [
			'A connected agent is an AI host — Cursor, Claude, ChatGPT, Codex, a CLI — that has authorized against this Kody account over MCP. Every connected host reaches the same memories, secrets, packages, jobs, and email; Kody is the home they share, not a gateway.',
		],
		learnMore: [
			{
				href: docHref('connect-your-agent'),
				label: 'Connect your agent',
			},
			packagesIntegrationsMcpGuide,
		],
	},
	{
		id: 'mcp-servers',
		question: 'What is an MCP server?',
		paragraphs: [
			'An MCP server here is a remote server Kody calls for you. Its tools become callable from your agent, the inverse of connecting your agent to Kody.',
		],
		learnMore: [packagesIntegrationsMcpGuide],
	},
	{
		id: 'memories',
		question: 'What is a memory?',
		paragraphs: [
			'A memory is a durable fact or preference Kody keeps about you across conversations. Agents retrieve a few relevant ones per task. Do not store secrets here.',
		],
		learnMore: [
			{
				href: docHref('what-is-kody'),
				label: 'What is Kody?',
			},
		],
	},
	{
		id: 'waiting',
		question: 'What is waiting?',
		paragraphs: [
			'Waiting is the queue of things only you can clear: verify email, reconnect an MCP server, promote a locked-package publish, confirm a pending email change, or finish setup.',
		],
		learnMore: [
			{ href: docHref('organizations'), label: 'Invites and organizations' },
		],
	},
	{
		id: 'experiments',
		question: 'What are experiments?',
		paragraphs: [
			'Experiments is an opt-in for early, unfinished work. It puts your account in the experiments audience. Each flag still has to be on for you, and you can opt out anytime.',
		],
		learnMore: [{ href: docHref('how-kody-works'), label: 'How Kody works' }],
	},
	{
		id: 'activity',
		question: 'What is activity?',
		paragraphs: [
			'Activity is a short execution history for jobs, package apps, webhooks, and other runtimes: open errors with logs and triage, plus the last week of runs.',
		],
		learnMore: [
			{ href: docHref('triggers'), label: 'Jobs, workflows, and webhooks' },
		],
	},
	{
		id: 'usage',
		question: 'What is usage?',
		paragraphs: [
			"Usage is how much of this organization's plan you have consumed — stored email, job slots, workflow concurrency, and other finite entitlements.",
			'On Pro, the Credits section holds the prepaid balance: usage past the monthly include runs on credits and stops when they run out.',
		],
		learnMore: [
			{
				href: docHref('organizations'),
				label: 'Organizations and billing',
			},
		],
	},
	{
		id: 'credits',
		question: 'What are credits?',
		paragraphs: [
			"Credits are this organization's prepaid balance. On Pro, usage past the monthly include is charged to them and stops when they run out.",
			'The ledger lists every credit added (purchases, auto-refills, grants) and every usage charge. Budgets cap how much one person or automation can spend each month.',
		],
		learnMore: [
			{
				href: docHref('organizations'),
				label: 'Organizations and billing',
			},
		],
	},
	{
		id: 'community',
		question: 'What is community?',
		paragraphs: [
			'Community is the public catalog of published packages on this deployment. Installing creates a fork you own.',
		],
		learnMore: [
			{
				href: docHref('what-is-kody'),
				label: 'What is Kody?',
			},
		],
	},
] as const

export type EntityExplainerId =
	(typeof entityExplainerDefinitions)[number]['id']

export function resolveEntityExplainer(
	id: EntityExplainerId | undefined,
): EntityExplainerCopy | null {
	const entry = entityExplainerDefinitions.find((item) => item.id === id)
	if (!entry) return null
	return {
		id: entry.id,
		question: entry.question,
		paragraphs: entry.paragraphs,
		...('learnMore' in entry ? { learnMore: entry.learnMore } : {}),
	}
}

/** One anchor for the single explainer mounted on a page. */
const entityExplainerAnchor = '--entity-explainer'

type EntityExplainerProps = {
	copy: EntityExplainerCopy
}

/**
 * Info button beside a page title. The panel is a declarative popover so
 * the shortened copy and its links work from server HTML: light dismiss,
 * Escape, and clicks, without a scroll lock.
 */
export function EntityExplainer(props: EntityExplainerProps) {
	const panelId = `entity-explainer-${props.copy.id}`
	const href = useMatchedPageScope().pageLocation.href
	useEffect(() => {
		document.getElementById(panelId)?.hidePopover()
	}, [href, panelId])

	{
		const copy = props.copy
		const titleId = `${panelId}-title`
		return (
			<>
				<button
					type="button"
					popoverTarget={panelId}
					aria-label={copy.question}
					data-entity-explainer-trigger={copy.id}
					css={entityExplainerButtonCss}
				>
					{renderIcon('information', { size: '1.35rem' })}
				</button>
				<div
					id={panelId}
					popover="auto"
					role="dialog"
					aria-labelledby={titleId}
					data-entity-explainer={copy.id}
					css={entityExplainerPanelCss}
				>
					<p id={titleId} css={entityExplainerTitleCss}>
						{copy.question}
					</p>
					{copy.paragraphs.map((paragraph) => (
						<p key={paragraph} css={entityExplainerBodyCss}>
							{paragraph}
						</p>
					))}
					{copy.learnMore?.map((link) => (
						<SiteLink
							key={link.href}
							href={link.href}
							css={entityExplainerLinkCss}
						>
							{link.label}
						</SiteLink>
					))}
				</div>
			</>
		)
	}
}

const entityExplainerButtonCss: CSSObject = {
	display: 'inline-flex',
	flex: 'none',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	marginInline: '-0.2rem',
	padding: 0,
	border: 'none',
	borderRadius: radius.full,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	anchorName: entityExplainerAnchor,
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			backgroundColor: colors.primarySoft,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const entityExplainerPanelCss: CSSObject = {
	// Leave `display` unset so a closed popover keeps the UA `display: none`.
	positionAnchor: entityExplainerAnchor,
	positionArea: 'bottom span-right',
	positionTryFallbacks: 'flip-block, flip-inline',
	inset: 'auto',
	width: 'min(28rem, calc(100vw - 2.5rem))',
	maxHeight: 'min(70dvh, 24rem)',
	overflow: 'auto',
	gap: '0.7rem',
	margin: '0.45rem',
	padding: '1rem 1.1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	boxSizing: 'border-box' as const,
	'&:popover-open': {
		display: 'grid',
	},
}

const entityExplainerTitleCss: CSSObject = {
	margin: 0,
	fontWeight: typography.fontWeight.bold,
	fontSize: '1.05rem',
	letterSpacing: '-0.02em',
	lineHeight: 1.25,
}

const entityExplainerBodyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.98rem',
	lineHeight: 1.5,
	textWrap: 'pretty' as const,
}

const entityExplainerLinkCss: CSSObject = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	fontSize: typography.fontSize.sm,
	width: 'fit-content',
	minHeight: '44px',
	display: 'inline-flex',
	alignItems: 'center',
}
