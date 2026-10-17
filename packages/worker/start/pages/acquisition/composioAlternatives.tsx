/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { composioAlternatives as page } from '#universal/acquisition/composioAlternatives.ts'
import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
const architectures = {
	personal: {
		label: 'My own workflows',
		owner: 'Your Kody account',
		input: ['Your GitHub connection', 'Your Slack connection'],
		center: 'Release digest package',
		state: 'Selection rules, formatting, progress',
		output: ['Claude', 'Another MCP client'],
		title: 'Keep the workflow when you switch agents.',
		detail:
			'Kody holds your connected accounts and saved operations outside a single chat. Build the release digest once, then call the same package from another connected agent.',
		link: '/docs/packages-integrations-mcp',
		linkLabel: 'How Kody packages and connections work',
	},
	customer: {
		label: 'Integrations in my product',
		owner: 'Your application',
		input: ['Customer A’s connection', 'Customer B’s connection'],
		center: 'Your application + integration tools',
		state: 'Customer accounts, connections, and tool calls',
		output: ['Customer A’s experience', 'Customer B’s experience'],
		title: 'How will your customers connect their accounts?',
		detail:
			'Composio provides authentication and tool APIs for integrations in your application. Kody brings your own agent workflows together with packages, memory, and schedules. Embedded customer authentication is a different requirement from connecting your own accounts.',
		link: 'https://docs.composio.dev/docs',
		linkLabel: 'Compare Composio’s integration model',
	},
} as const
export function ComposioAlternativesPage() {
	const [selected, setSelected] =
		useState<keyof typeof architectures>('personal')
	const architecture = architectures[selected]
	return (
		<article css={styles}>
			<header className="opening">
				<h1>{page.title}</h1>
				<div>
					<p>Give your agents more than a connection.</p>
					<p className="lead">
						Connect your accounts, build useful tools with your agent, and keep
						the code, task defaults, and schedules together in Kody.
					</p>
					<SiteLink href="#ownership">See how it works ↓</SiteLink>
				</div>
			</header>
			<section
				id="ownership"
				className="decision"
				aria-label="Compare integration ownership"
			>
				<div
					className="choices"
					role="group"
					aria-label="What are you building?"
				>
					{(
						Object.keys(architectures) as Array<keyof typeof architectures>
					).map((key) => (
						<button
							key={key}
							type="button"
							aria-pressed={selected === key ? 'true' : 'false'}
							onClick={() => {
								setSelected(key)
							}}
						>
							{architectures[key].label}
							<span aria-hidden="true">↗</span>
						</button>
					))}
				</div>
				<div className="architecture" aria-live="polite">
					<div
						className="ownership-map"
						aria-label={`${architecture.owner}, illustrative ownership map`}
					>
						<p className="map-title">{architecture.owner}</p>
						<div className="endpoints">
							{architecture.input.map((item) => (
								<div key={item}>{item}</div>
							))}
						</div>
						<div className="connector" aria-hidden="true">
							↓
						</div>
						<div className="operation">
							<strong>{architecture.center}</strong>
							<span>{architecture.state}</span>
						</div>
						<div className="connector" aria-hidden="true">
							↓
						</div>
						<div className="endpoints agents">
							{architecture.output.map((item) => (
								<div key={item}>{item}</div>
							))}
						</div>
						<small>Example only, this doesn’t connect any accounts.</small>
					</div>
					<div className="recommendation">
						<h2>{architecture.title}</h2>
						<p>{architecture.detail}</p>
						<SiteLink href={architecture.link}>
							{architecture.linkLabel} ↗
						</SiteLink>
					</div>
				</div>
			</section>
			<section className="alternatives">
				<h2>Keep building on your connected accounts.</h2>
				<dl>
					<div>
						<dt>Start with one useful tool</dt>
						<dd>
							Connect a service and ask your agent to build the operation you
							need. Save it as a package so your other agents can use it too.
						</dd>
					</div>
					<div>
						<dt>Add a schedule when it works</dt>
						<dd>
							Run the same package on a schedule, with its connected accounts
							and saved progress.{' '}
							<SiteLink href="/use-cases/scheduled-workflows">
								Build a scheduled workflow ↗
							</SiteLink>
						</dd>
					</div>
				</dl>
			</section>
			<section className="evaluation">
				<div>
					<h2>Try a workflow you can keep.</h2>
					<p>
						Start with a GitHub lookup, save the code, then use it from another
						agent. Add a second service when you’re ready to do more.
					</p>
				</div>
				<ol>
					{page.sections[3]!.steps!.map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
			</section>
			<section id="try-it" className="trial">
				<div>
					<h2>Try the personal workflow.</h2>
					<p>
						Connect your agent to Kody and try a GitHub lookup, then run the
						same saved tool from another agent.
					</p>
					<SiteLink href="/onboarding" css={getPillButtonCss()}>
						Get started with Kody
					</SiteLink>
				</div>
				<div className="prompt">
					<p>{page.prompt}</p>
					<CopyTextButton value={page.prompt} idleLabel="Copy prompt" />
				</div>
			</section>
			<footer className="references">
				<div>
					<h2>Documentation</h2>
					{page.sources.map((source) => (
						<SiteLink key={source.href} href={source.href}>
							{source.label} ↗
						</SiteLink>
					))}
				</div>
				<nav aria-label="Related use cases">
					<h2>Related guides</h2>
					{page.related.map((key) => (
						<SiteLink key={key} href={acquisitionPageMeta[key].path}>
							{acquisitionPageMeta[key].title} ↗
						</SiteLink>
					))}
				</nav>
			</footer>
		</article>
	)
}
const styles: CSSObject = {
	maxWidth: '72rem',
	margin: '0 auto',
	padding: '4rem 1.5rem 6rem',
	color: colors.text,
	'& h1, & h2': {
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: 500,
		margin: 0,
	},
	'& h1': { fontSize: '3.6rem', lineHeight: 1.08, maxWidth: '17ch' },
	'& h2': { fontSize: '2rem', lineHeight: 1.15 },
	'& p': { lineHeight: 1.7 },
	'& a:focus-visible, & button:focus-visible': {
		outline: `3px solid ${colors.primary}`,
		outlineOffset: '5px',
	},
	'& .opening': {
		display: 'grid',
		gridTemplateColumns: '1.3fr 1fr',
		gap: '4rem',
		alignItems: 'end',
		marginBottom: '3.5rem',
	},
	'& .opening p:first-child': {
		fontSize: '1.45rem',
		fontWeight: 600,
		lineHeight: 1.35,
	},
	'& .lead': { color: colors.textMuted, maxWidth: '40ch' },
	'& .decision': {
		border: `1px solid ${colors.border}`,
		borderRadius: '1rem',
		overflow: 'hidden',
		scrollMarginTop: '6rem',
	},
	'& .choices': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .choices button': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		font: 'inherit',
		fontWeight: 600,
		padding: '1.4rem',
		border: 0,
		background: colors.surface,
		color: colors.text,
		cursor: 'pointer',
		textAlign: 'left',
	},
	'& .choices button[aria-pressed="true"]': {
		background: colors.primary,
		color: colors.onPrimary,
	},
	'& .architecture': { display: 'grid', gridTemplateColumns: '1.2fr 1fr' },
	'& .ownership-map': { padding: '2rem', background: colors.surface },
	'& .map-title': {
		margin: '0 0 1.5rem',
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.8rem',
		color: colors.textMuted,
	},
	'& .endpoints': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '1rem',
	},
	'& .endpoints div': {
		border: `1px solid ${colors.border}`,
		borderRadius: '0.4rem',
		background: colors.background,
		padding: '1rem',
		fontSize: '0.9rem',
		textAlign: 'center',
	},
	'& .connector': {
		textAlign: 'center',
		color: colors.primaryText,
		fontSize: '1.7rem',
		lineHeight: 1.6,
	},
	'& .operation': {
		border: `2px solid ${colors.primary}`,
		padding: '1.5rem',
		textAlign: 'center',
		borderRadius: '0.5rem',
	},
	'& .operation strong': { display: 'block', fontSize: '1.2rem' },
	'& .operation span': {
		display: 'block',
		marginTop: '0.4rem',
		color: colors.textMuted,
		fontSize: '0.85rem',
	},
	'& .ownership-map small': {
		display: 'block',
		marginTop: '1.5rem',
		color: colors.textMuted,
		fontSize: '0.75rem',
	},
	'& .recommendation': { padding: '3rem 2rem', alignSelf: 'center' },
	'& .recommendation p': { color: colors.textMuted },
	'& .alternatives': {
		padding: '5rem 0',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .alternatives h2': { maxWidth: '22ch' },
	'& dl': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		margin: '2.5rem 0 0',
	},
	'& dt': { fontSize: '1.2rem', fontWeight: 600 },
	'& dd': { margin: '0.75rem 0 0', lineHeight: 1.7, color: colors.textMuted },
	'& .evaluation': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.2fr',
		gap: '5rem',
		padding: '5rem 0',
	},
	'& .evaluation p': { color: colors.textMuted },
	'& ol': { margin: 0, paddingLeft: '1.6rem' },
	'& li': { padding: '0 0 1.2rem 0.6rem', lineHeight: 1.6 },
	'& li::marker': {
		color: colors.primaryText,
		fontFamily: typography.fontFamilyMono,
	},
	'& .trial': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.2fr',
		gap: '3rem',
		padding: '2.5rem',
		background: colors.primarySoft,
		borderRadius: '1rem',
		scrollMarginTop: '6rem',
	},
	'& .prompt': {
		borderLeft: `2px solid ${colors.primary}`,
		paddingLeft: '2rem',
	},
	'& .prompt p': { marginTop: 0 },
	'& .references': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '3rem',
		paddingTop: '4rem',
	},
	'& .references h2': { fontSize: '1.25rem', marginBottom: '1rem' },
	'& .references a': {
		display: 'block',
		padding: '0.45rem 0',
		fontSize: '0.9rem',
	},
	'@media (max-width: 760px)': {
		padding: '2rem 1.25rem 4rem',
		'& h1': { fontSize: '2.65rem' },
		'& .opening, & .architecture, & .evaluation, & .trial, & .references, & dl':
			{ gridTemplateColumns: '1fr', gap: '2rem' },
		'& .opening': { marginBottom: '2rem' },
		'& .opening p:first-child': { marginTop: 0 },
		'& .choices button': { padding: '1rem', fontSize: '0.9rem' },
		'& .ownership-map': { padding: '1.25rem' },
		'& .recommendation': { padding: '0 1.25rem 2rem' },
		'& .endpoints': { gap: '0.5rem' },
		'& .endpoints div': { padding: '0.8rem 0.5rem', fontSize: '0.8rem' },
		'& .alternatives, & .evaluation': { padding: '3rem 0' },
		'& .trial': { padding: '1.5rem' },
		'& .prompt': { paddingLeft: '1rem' },
	},
}
