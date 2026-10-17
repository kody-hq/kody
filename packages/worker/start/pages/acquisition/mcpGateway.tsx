/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { mcpGateway } from '#universal/acquisition/mcpGateway.ts'
import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
const stages = [
	{
		label: 'Discover',
		operation: 'search',
		request: 'Find a saved tool that lists GitHub releases.',
		response:
			'Found: release-watch\nInput: repository\nOutput: published releases',
		explanation:
			'The agent finds the tool, checks what it needs, and sees what it returns.',
	},
	{
		label: 'Run',
		operation: 'execute',
		request: 'Run release-watch for example/project.',
		response:
			'Repository: example/project\nLatest release: v2.4.0\nPublished: October 8\nChanges: improved export support',
		explanation:
			'The agent runs your saved tool, using the code in the package and access from your connected account.',
	},
	{
		label: 'Switch agents',
		operation: 'search → execute',
		request: 'From another agent: run my release lookup again.',
		response: 'Same account\nSame release-watch package\nSame inputs',
		explanation:
			'Connect another agent to your account and reuse the package. You don’t have to rebuild the tool in the next conversation.',
	},
] as const
const styles = {
	background: 'light-dark(#f4f3ed, var(--color-surface))',
	color: 'light-dark(#22342f, var(--color-text))',
	padding: '4rem 1.5rem 5rem',
	'& *': { boxSizing: 'border-box' },
	'& .gateway-wrap': { maxWidth: '1120px', margin: '0 auto' },
	'& h1, & h2, & h3': {
		fontFamily: 'var(--font-family-display, var(--font-family))',
		fontWeight: 500,
		textWrap: 'balance',
	},
	'& h1': {
		fontSize: '4rem',
		lineHeight: 1.07,
		maxWidth: '760px',
		margin: '0 0 1.5rem',
	},
	'& h2': { fontSize: '2.3rem', lineHeight: 1.15, margin: '0 0 1.25rem' },
	'& h3': { fontSize: '1.2rem', margin: '0 0 .7rem' },
	'& p': { lineHeight: 1.65 },
	'& .lead': { maxWidth: '660px', fontSize: '1.15rem', marginBottom: '1.5rem' },
	'& a:focus-visible, & button:focus-visible': {
		outline: '3px solid light-dark(#bd512f, var(--color-field-border))',
		outlineOffset: '5px',
	},
	'& .cta': {
		display: 'inline-flex',
		padding: '.8rem 1.3rem',
		background: 'light-dark(#243f34, var(--color-primary))',
		color: 'light-dark(#fff, var(--color-on-primary))',
		borderRadius: '30px',
		textDecoration: 'none',
	},
	'& .hero-links': {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: '1.5rem',
	},
	'& .topology': {
		margin: '3rem 0 4rem',
		display: 'grid',
		gridTemplateColumns: '1fr 1.15fr 1fr',
		alignItems: 'center',
		gap: '3rem',
	},
	'& .ports': { display: 'grid', gap: '.6rem', position: 'relative' },
	'& .port': {
		border: '1px solid light-dark(#b7c2b9, var(--color-border))',
		padding: '1rem',
		background: 'light-dark(#fbfbf6, var(--color-surface))',
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
	},
	'& .ports:first-child::after': {
		content: '""',
		position: 'absolute',
		right: '-3rem',
		width: '3rem',
		top: '50%',
		height: '1px',
		background: 'light-dark(#6f897b, var(--color-surface))',
	},
	'& .ports:last-child::before': {
		content: '""',
		position: 'absolute',
		left: '-3rem',
		width: '3rem',
		top: '50%',
		height: '1px',
		background: 'light-dark(#6f897b, var(--color-surface))',
	},
	'& .core': {
		background: 'light-dark(#243f34, var(--color-surface))',
		color: 'light-dark(#f6f8ed, var(--color-text))',
		padding: '2rem',
		textAlign: 'center',
		borderRadius: '50% / 18%',
		border: '1px solid light-dark(#243f34, var(--color-border))',
	},
	'& .core strong': { display: 'block', fontSize: '2.5rem', fontWeight: 500 },
	'& .core code': {
		display: 'block',
		margin: '1rem 0',
		fontSize: '.85rem',
		color: 'light-dark(#d9ee8b, var(--color-text))',
	},
	'& .core small': { lineHeight: 1.5, display: 'block' },
	'& .trace': {
		background: 'light-dark(#182d26, var(--color-surface))',
		color: 'light-dark(#f2f5ed, var(--color-text))',
		padding: '2rem',
		marginBottom: '5rem',
	},
	'& .trace-heading': {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'baseline',
		gap: '1rem',
		flexWrap: 'wrap',
	},
	'& .trace-heading small': { color: 'light-dark(#c5d1c6, var(--color-text))' },
	'& .stage-buttons': {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '.5rem',
		margin: '1rem 0 2rem',
	},
	'& .stage-buttons button': {
		cursor: 'pointer',
		font: 'inherit',
		padding: '.75rem 1rem',
		border: '1px solid light-dark(#738b7e, var(--color-border))',
		color: 'light-dark(#e1e9df, var(--color-text))',
		background: 'transparent',
	},
	'& .stage-buttons button[aria-pressed="true"]': {
		background: 'light-dark(#d9ee8b, var(--color-primary))',
		color: 'light-dark(#182d26, var(--color-on-primary))',
		borderColor: 'light-dark(#d9ee8b, var(--color-border))',
	},
	'& .trace-body': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '2rem',
		minHeight: '215px',
	},
	'& .request': { fontSize: '1.45rem', lineHeight: 1.45, margin: '1rem 0' },
	'& .operation': {
		color: 'light-dark(#d9ee8b, var(--color-text))',
		fontSize: '.9rem',
	},
	'& pre': {
		margin: 0,
		whiteSpace: 'pre-wrap',
		overflowWrap: 'anywhere',
		fontSize: '.88rem',
		lineHeight: 1.9,
		fontFamily: 'monospace',
	},
	'& .response': {
		borderLeft: '1px solid light-dark(#567361, var(--color-border))',
		paddingLeft: '2rem',
	},
	'& .trace-note': {
		color: 'light-dark(#c5d1c6, var(--color-text))',
		maxWidth: '760px',
		margin: '1rem 0 0',
	},
	'& .decision': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.7fr',
		gap: '4rem',
		marginBottom: '5rem',
	},
	'& .option': {
		borderTop: '1px solid light-dark(#aeb9ad, var(--color-border))',
		padding: '1.5rem 0',
	},
	'& .option p': { margin: 0 },
	'& .ownership': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingTop: '2rem',
		borderTop: '1px solid light-dark(#aeb9ad, var(--color-border))',
		marginBottom: '4rem',
	},
	'& .ownership dl': { margin: 0 },
	'& .ownership dt': { fontWeight: 600, marginTop: '1rem' },
	'& .ownership dd': { margin: '.3rem 0 1.5rem', lineHeight: 1.6 },
	'& .prompt': {
		borderLeft: '5px solid light-dark(#be633f, var(--color-border))',
		padding: '0 0 0 2rem',
		maxWidth: '820px',
		margin: '0 0 4rem',
		scrollMarginTop: '6rem',
	},
	'& .prompt p': { fontSize: '1.15rem' },
	'& .reading': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '3rem',
		borderTop: '1px solid light-dark(#aeb9ad, var(--color-border))',
		paddingTop: '2rem',
	},
	'& .reading a': { display: 'block', padding: '.65rem 0', lineHeight: 1.5 },
	'@media (max-width: 700px)': {
		padding: '2.5rem 1.25rem 3rem',
		'& h1': { fontSize: '2.65rem' },
		'& h2': { fontSize: '1.9rem' },
		'& .topology': {
			gridTemplateColumns: '1fr',
			gap: '1.5rem',
			margin: '2.5rem 0',
		},
		'& .ports': { gridTemplateColumns: 'repeat(3, 1fr)', gap: '.35rem' },
		'& .port': {
			padding: '.7rem .3rem',
			fontSize: '.75rem',
			justifyContent: 'center',
			textAlign: 'center',
		},
		'& .port span': { display: 'none' },
		'& .ports:first-child::after, & .ports:last-child::before': {
			width: '1px',
			height: '1.5rem',
			left: '50%',
			top: 'auto',
			right: 'auto',
		},
		'& .ports:first-child::after': { bottom: '-1.5rem' },
		'& .ports:last-child::before': { top: '-1.5rem' },
		'& .core': {
			padding: '1rem',
			borderRadius: '16px',
			maxWidth: '270px',
			width: '100%',
			margin: 'auto',
		},
		'& .core strong': { fontSize: '1.75rem' },
		'& .core code': { margin: '.5rem 0' },
		'& .trace': { padding: '1.3rem', marginBottom: '3rem' },
		'& .trace-body, & .decision, & .ownership, & .reading': {
			gridTemplateColumns: '1fr',
			gap: '1.5rem',
		},
		'& .response': {
			borderLeft: 0,
			borderTop: '1px solid light-dark(#567361, var(--color-border))',
			paddingLeft: 0,
			paddingTop: '1rem',
		},
		'& .decision, & .ownership': { marginBottom: '3rem' },
		'& .prompt': { paddingLeft: '1.25rem' },
	},
} as const
export function McpGatewayPage() {
	const [stage, setStage] = useState(0)
	const active = stages[stage] ?? stages[0]
	return (
		<div css={styles}>
			<div className="gateway-wrap">
				<header>
					<h1>{mcpGateway.title}</h1>
					<p className="lead">
						Connect Claude, Cursor, and Codex to the same tools. Keep the
						workflows you build and their saved progress in your Kody account.
					</p>
					<div className="hero-links">
						<SiteLink className="cta" href="/onboarding">
							Connect your agent ↗
						</SiteLink>
						<SiteLink href="#gateway-trace">Follow a tool call ↓</SiteLink>
					</div>
				</header>
				<div
					className="topology"
					aria-label="Claude, Cursor, and Codex connect through Kody search and execute to connected accounts, saved packages, and remote MCP servers"
				>
					<div className="ports">
						{['Claude', 'Cursor', 'Codex'].map((name) => (
							<div className="port" key={name}>
								{name}
								<span aria-hidden="true">→</span>
							</div>
						))}
					</div>
					<div className="core">
						<strong>Kody</strong>
						<code>search · execute</code>
						<small>Your account’s tools, code, and memory</small>
					</div>
					<div className="ports">
						{['Connected accounts', 'Saved packages', 'Remote MCP servers'].map(
							(name) => (
								<div className="port" key={name}>
									{name}
								</div>
							),
						)}
					</div>
				</div>
				<section
					className="trace"
					id="gateway-trace"
					aria-label="Example tool lookup and run"
				>
					<div className="trace-heading">
						<h2>Use the same tool from another agent.</h2>
						<small>Example only, no live tool calls</small>
					</div>
					<div
						className="stage-buttons"
						role="group"
						aria-label="Explore the tool call"
					>
						{stages.map((item, index) => (
							<button
								key={item.label}
								type="button"
								aria-pressed={stage === index ? 'true' : 'false'}
								onClick={() => {
									setStage(index)
								}}
							>
								{index + 1}. {item.label}
							</button>
						))}
					</div>
					<div aria-live="polite">
						<div className="trace-body">
							<div>
								<code className="operation">{active.operation}</code>
								<p className="request">{active.request}</p>
							</div>
							<div className="response">
								<pre>{active.response}</pre>
							</div>
						</div>
						<p className="trace-note">{active.explanation}</p>
					</div>
				</section>
				<section className="decision">
					<h2>Bring your tools and workflows together.</h2>
					<div>
						<div className="option">
							<h3>Connect your MCP tools</h3>
							<p>
								Connect your MCP servers to Kody so your agents can discover
								their tools through one account.
							</p>
						</div>
						<div className="option">
							<h3>Keep access in one place</h3>
							<p>
								Your service connections stay in Kody. Switch agents without
								rebuilding the connections for each workflow.
							</p>
						</div>
						<div className="option">
							<h3>Kody</h3>
							<p>
								Use Kody when you want to keep the workflow you built with those
								tools. Your agent can combine them in code and save that code
								and its progress in a package.
							</p>
						</div>
					</div>
				</section>
				<section className="ownership">
					<div>
						<h2>Keep the workflow you built.</h2>
						<p>
							Once your agent has built a workflow around a connected service,
							save it as a package so you can use the code again in the next
							conversation.
						</p>
						<p>
							If you’re choosing a gateway for a company, check its team
							controls, audit exports, deployment options, and access rules.
							Sharing tools between your own agents doesn’t cover all of those
							needs.
						</p>
					</div>
					<dl>
						<dt>Integration</dt>
						<dd>
							A saved connection that lets Kody use one of your service
							accounts.
						</dd>
						<dt>Package</dt>
						<dd>Your code, exports, storage, and optional scheduled jobs.</dd>
						<dt>Remote MCP server</dt>
						<dd>
							An existing server Kody connects to. This doesn’t mean hosting an
							arbitrary server process inside a package.
						</dd>
					</dl>
				</section>
				<section className="prompt" id="try-it">
					<h2>Build a release lookup you can take to another agent.</h2>
					<p>{mcpGateway.prompt}</p>
					<CopyTextButton value={mcpGateway.prompt} idleLabel="Copy prompt" />
					<p>
						<SiteLink href="/onboarding">
							Connect an agent to get started ↗
						</SiteLink>
					</p>
				</section>
				<div className="reading">
					<nav aria-label="MCP gateway documentation">
						<h3>Wire it up</h3>
						{mcpGateway.sources.map((source) => (
							<SiteLink key={source.href} href={source.href}>
								{source.label} ↗
							</SiteLink>
						))}
					</nav>
					<nav aria-label="Related workflows">
						<h3>Related guides</h3>
						{mcpGateway.related.map((key) => (
							<SiteLink key={key} href={acquisitionPageMeta[key].path}>
								{acquisitionPageMeta[key].title} →
							</SiteLink>
						))}
					</nav>
				</div>
			</div>
		</div>
	)
}
