/** @jsxImportSource @emotion/react */
import { publicAsset } from '../../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { claudeIntegrations as page } from '#universal/acquisition/claudeIntegrations.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
const clients = ['Claude', 'Claude Code', 'Another MCP agent'] as const
const methods = [
	{
		name: 'Connected accounts',
		task: 'I need one service in Claude.',
		description:
			'Connect the services you use to Kody, then ask Claude to work with them from your conversation.',
		check:
			'Your service connections stay in Kody, ready for your other connected agents too.',
		href: '/docs/packages-integrations-mcp',
		link: 'Connect your accounts',
	},
	{
		name: 'MCP tools',
		task: 'I want to connect my MCP tools.',
		description:
			'Connect an MCP server to Kody and let your agents discover and use its tools through the same account.',
		check:
			'Combine those tools with saved package code when a task takes more than one call.',
		href: '/docs/connect-your-agent',
		link: 'Read the connection guide',
	},
	{
		name: 'Kody',
		task: 'I want to keep using what I build.',
		description:
			'Connect your agents to the same Kody account. Keep useful behavior in packages, facts without a better home in memory, and service connections in one place.',
		check:
			'Connect the service separately, then test the specific operation you need.',
		href: '/onboarding',
		link: 'Connect to Kody',
	},
]
export function ClaudeIntegrationsPage() {
	const [client, setClient] = useState(0)
	const [method, setMethod] = useState(2)
	return (
		<article css={styles}>
			<header className="opening">
				<h1>{page.title}</h1>
				<div className="opening-copy">
					<p>
						Start in Claude, then use what you built from your other agents,
						too. Kody keeps your saved tools, accounts, and facts in one place.
					</p>
					<SiteLink href="/onboarding" css={getPillButtonCss()}>
						Connect Claude to Kody ↗
					</SiteLink>
					<SiteLink className="quiet-link" href="#choose">
						Find the right connection ↓
					</SiteLink>
				</div>
			</header>

			<section
				className="switchboard"
				aria-label="Example of saved resources across agents"
			>
				<div className="board-top">
					<strong>Your agents change. Your saved work stays.</strong>
					<span>Interactive example</span>
				</div>
				<div className="board-body">
					<div className="agent-side">
						<div
							className="agent-picker"
							role="group"
							aria-label="Choose an example agent"
						>
							{clients.map((name, index) => (
								<button
									key={name}
									type="button"
									aria-pressed={client === index ? 'true' : 'false'}
									onClick={() => {
										setClient(index)
									}}
								>
									{name}
								</button>
							))}
						</div>
						<div className="agent-window" aria-live="polite">
							<span className="client-name">{clients[client]}</span>
							<p className="request">
								{client === 0
									? 'Save this weekly report workflow in Kody so I can use it again.'
									: client === 1
										? 'Find my weekly report package in Kody. Let’s improve the output.'
										: 'Find my weekly report package and run it with its documented defaults.'}
							</p>
							<p className="operation">
								{client === 0
									? 'Create a reusable package'
									: client === 1
										? 'Find and revise the saved package'
										: 'Find and run the saved package'}
							</p>
						</div>
						<p className="connection-note">
							Each agent connects to the same Kody account.
						</p>
					</div>
					<div className="resource-side">
						<div className="account-title">
							<img
								src={publicAsset('/logo-64.webp')}
								width={32}
								height={32}
								alt=""
							/>
							<strong>Your Kody account</strong>
						</div>
						<dl>
							<div>
								<dt>Package</dt>
								<dd>
									weekly-report<span>Saved instructions and code</span>
								</dd>
							</div>
							<div>
								<dt>Package defaults</dt>
								<dd>
									Report format<span>Defined with the report’s code</span>
								</dd>
							</div>
							<div>
								<dt>Connection</dt>
								<dd>
									Your service account
									<span>Access to the service</span>
								</dd>
							</div>
						</dl>
						<p className="scope">
							Your chats stay in the app where you had them. Your other agents
							can use the tools and context you save in Kody.
						</p>
					</div>
				</div>
			</section>

			<section id="choose" className="chooser">
				<div className="chooser-heading">
					<h2>What are you connecting?</h2>
					<p>
						Connect your accounts, bring your MCP tools, and keep the workflows
						you build in Kody.
					</p>
				</div>
				<div className="decision-layout">
					<div
						className="decisions"
						role="group"
						aria-label="Choose your integration need"
					>
						{methods.map((item, index) => (
							<button
								key={item.name}
								type="button"
								aria-pressed={method === index ? 'true' : 'false'}
								onClick={() => {
									setMethod(index)
								}}
							>
								<span>{item.task}</span>
								<span aria-hidden="true">↗</span>
							</button>
						))}
					</div>
					<div className="recommendation" aria-live="polite">
						<h3>{methods[method]!.name}</h3>
						<p>{methods[method]!.description}</p>
						<p className="check">{methods[method]!.check}</p>
						<SiteLink href={methods[method]!.href}>
							{methods[method]!.link} ↗
						</SiteLink>
					</div>
				</div>
			</section>

			<section className="setup">
				<h2>
					Two connections.
					<br />
					One useful test.
				</h2>
				<ol>
					<li>
						<h3>Connect Claude to Kody</h3>
						<p>
							This gives your agent access to your Kody account. Follow the
							guide for the client you use.
						</p>
						<SiteLink href="/docs/connect-your-agent">
							Agent connection guide ↗
						</SiteLink>
					</li>
					<li>
						<h3>Connect the service to Kody</h3>
						<p>
							A Google or Slack connection supplies that service’s
							authentication. Connecting Claude alone doesn’t grant it access to
							your inbox.
						</p>
						<SiteLink href="/docs/packages-integrations-mcp">
							How integrations fit together ↗
						</SiteLink>
					</li>
					<li>
						<h3>Read something small, then save what helps</h3>
						<p>
							Try a task that reads data, check that it’s using the right
							account, then save useful code and its defaults in a package. Ask
							a second agent to find what you saved.
						</p>
						<SiteLink href="/docs/portability">
							What carries between agents ↗
						</SiteLink>
					</li>
				</ol>
			</section>

			<section id="try-it" className="try-it">
				<div>
					<h2>Give Claude a starting point.</h2>
					<p>Use this prompt after connecting your account.</p>
					<SiteLink href="/onboarding" css={getPillButtonCss()}>
						Set up Kody ↗
					</SiteLink>
				</div>
				<div className="prompt">
					<blockquote>{page.prompt}</blockquote>
					<CopyTextButton
						value={page.prompt}
						idleLabel="Copy prompt"
						variant="pill"
					/>
				</div>
			</section>
			<nav className="next" aria-label="Related use cases">
				<SiteLink href="/integrations/gmail">Build a Gmail workflow ↗</SiteLink>
				<SiteLink href="/use-cases/shared-agent-memory">
					Keep shared agent memory ↗
				</SiteLink>
				<SiteLink href="/use-cases/claude-code-custom-tools">
					Build custom tools for Claude Code ↗
				</SiteLink>
			</nav>
		</article>
	)
}
const styles = {
	maxWidth: '1180px',
	margin: '0 auto',
	padding: '4rem 2rem 5rem',
	color: colors.text,
	'& h1, & h2, & h3': {
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: 450,
		margin: 0,
	},
	'& h1': { fontSize: '4rem', lineHeight: 1.06, maxWidth: '780px' },
	'& h2': { fontSize: '2.7rem', lineHeight: 1.12 },
	'& h3': { fontSize: '1.55rem', lineHeight: 1.25 },
	'& p': { lineHeight: 1.7 },
	'& button': { font: 'inherit', cursor: 'pointer' },
	'& button:focus-visible, & a:focus-visible': {
		outline: `2px solid ${colors.primaryText}`,
		outlineOffset: '4px',
	},
	'& .opening': {
		display: 'grid',
		gridTemplateColumns: '1.45fr 1fr',
		gap: '3rem',
		alignItems: 'end',
		marginBottom: '3rem',
	},
	'& .opening-copy p': {
		fontSize: '1.1rem',
		marginTop: 0,
		marginBottom: '1.5rem',
		color: colors.textMuted,
	},
	'& .quiet-link': {
		display: 'block',
		marginTop: '1.25rem',
		fontSize: '0.9rem',
	},
	'& .switchboard': {
		border: `1px solid ${colors.border}`,
		borderRadius: '12px',
		overflow: 'hidden',
		background: colors.surface,
	},
	'& .board-top': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		padding: '1rem 1.5rem',
		borderBottom: `1px solid ${colors.border}`,
		fontSize: '0.9rem',
	},
	'& .board-top span': {
		color: colors.textMuted,
		fontSize: '0.8rem',
		whiteSpace: 'nowrap' as const,
	},
	'& .board-body': { display: 'grid', gridTemplateColumns: '1.2fr 1fr' },
	'& .agent-side': {
		padding: '2rem',
		borderRight: `1px solid ${colors.border}`,
	},
	'& .agent-picker': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '0.5rem',
		marginBottom: '1.5rem',
	},
	'& .agent-picker button': {
		border: `1px solid ${colors.border}`,
		borderRadius: '100px',
		padding: '0.6rem 0.85rem',
		background: 'transparent',
		color: colors.textMuted,
		fontSize: '0.8rem',
	},
	'& .agent-picker button[aria-pressed="true"]': {
		background: colors.primary,
		color: colors.onPrimary,
		borderColor: colors.primary,
	},
	'& .agent-window': {
		background: colors.background,
		border: `1px solid ${colors.border}`,
		borderRadius: '8px',
		padding: '1.5rem',
		minHeight: '218px',
	},
	'& .client-name': {
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.8rem',
		color: colors.textMuted,
	},
	'& .request': {
		fontSize: '1.3rem',
		lineHeight: 1.5,
		margin: '1rem 0 1.5rem',
	},
	'& .operation': { color: colors.primaryText, fontSize: '0.85rem', margin: 0 },
	'& .connection-note': {
		fontSize: '0.8rem',
		marginBottom: 0,
		color: colors.textMuted,
	},
	'& .resource-side': { padding: '2rem', background: colors.primarySoftest },
	'& .account-title': {
		display: 'flex',
		alignItems: 'center',
		gap: '0.75rem',
		marginBottom: '1.5rem',
	},
	'& dl': { margin: 0 },
	'& dl > div': {
		display: 'grid',
		gridTemplateColumns: '100px 1fr',
		gap: '1rem',
		paddingBlock: '1rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& dt': { fontSize: '0.8rem', color: colors.textMuted },
	'& dd': { margin: 0, fontSize: '0.95rem' },
	'& dd span': {
		display: 'block',
		fontSize: '0.8rem',
		color: colors.textMuted,
		marginTop: '0.3rem',
	},
	'& .scope': {
		margin: '1rem 0 0',
		fontSize: '0.85rem',
		color: colors.textMuted,
	},
	'& .chooser': { paddingBlock: '5rem' },
	'& .chooser-heading': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '3rem',
		marginBottom: '2rem',
	},
	'& .chooser-heading p': { margin: 0, color: colors.textMuted },
	'& .decision-layout': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '3rem',
	},
	'& .decisions button': {
		display: 'flex',
		justifyContent: 'space-between',
		textAlign: 'left' as const,
		width: '100%',
		padding: '1.4rem 1rem',
		border: 0,
		borderBottom: `1px solid ${colors.border}`,
		color: colors.text,
		background: 'transparent',
		gap: '1rem',
	},
	'& .decisions button[aria-pressed="true"]': {
		background: colors.primarySoft,
		color: colors.primaryText,
	},
	'& .recommendation': { padding: '1.4rem 0', minHeight: '275px' },
	'& .check': { color: colors.textMuted, fontSize: '0.9rem' },
	'& .setup': {
		display: 'grid',
		gridTemplateColumns: '0.85fr 1.15fr',
		gap: '4rem',
		paddingBlock: '4rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& .setup ol': { margin: 0, paddingLeft: '1.5rem' },
	'& .setup li': { paddingLeft: '1rem', paddingBottom: '2rem' },
	'& .setup li:last-child': { paddingBottom: 0 },
	'& .setup li::marker': {
		color: colors.primaryText,
		fontFamily: typography.fontFamilyMono,
	},
	'& .setup p': { color: colors.textMuted, marginBlock: '0.75rem' },
	'& .setup a': { fontSize: '0.85rem' },
	'& .try-it': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '3rem',
		padding: '2.5rem',
		background: colors.primarySoftest,
		borderRadius: '12px',
	},
	'& .try-it p': { color: colors.textMuted, marginBottom: '1.5rem' },
	'& blockquote': { margin: '0 0 1.5rem', lineHeight: 1.8 },
	'& .next': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '1rem 2rem',
		marginTop: '2rem',
		fontSize: '0.9rem',
	},
	'@media (max-width: 760px)': {
		padding: '2rem 1.25rem 3rem',
		'& h1': { fontSize: '2.8rem' },
		'& h2': { fontSize: '2.1rem' },
		'& .opening, & .board-body, & .chooser-heading, & .decision-layout, & .setup, & .try-it':
			{ gridTemplateColumns: '1fr', gap: '1.5rem' },
		'& .opening': { marginBottom: '2rem' },
		'& .board-body': { gap: 0 },
		'& .board-top': { flexDirection: 'column' as const, gap: '0.25rem' },
		'& .agent-side': {
			borderRight: 0,
			borderBottom: `1px solid ${colors.border}`,
			padding: '1.25rem',
		},
		'& .resource-side': { padding: '1.25rem' },
		'& .agent-window': { minHeight: '220px', padding: '1.25rem' },
		'& .chooser': { paddingBlock: '3rem' },
		'& .recommendation': { minHeight: '260px' },
		'& .setup': { paddingBlock: '3rem' },
		'& .try-it': { padding: '1.5rem' },
		'& dl > div': { gridTemplateColumns: '85px 1fr', gap: '0.5rem' },
	},
}
