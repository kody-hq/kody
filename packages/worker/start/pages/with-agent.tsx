/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type CSSProperties } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { BuildWithAgentButton } from '../components/build-with-agent-button.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { docHref } from '#universal/docs-nav.ts'
import { landingHomePrimitives } from '#universal/landing-home-copy.ts'
import { primitiveFeatureHref } from '#universal/primitive-cards.ts'
import { pageGutter, pageHeadCss } from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	withAgentHref,
	withAgentIconSrc,
	withAgents,
	type WithAgent,
	type WithAgentStep,
} from '#universal/with-agents.ts'

/**
 * `/with/:agent`: one agent, why it is better with Kody, and the shortest
 * way to connect it. The homepage agent marquee links here. Unknown slugs
 * 404 on the server, so the client only renders catalog agents.
 */
export function WithAgentRoute({ agent }: { agent: WithAgent }) {
	const others = withAgents.filter((other) => other.slug !== agent.slug)
	return (
		<article css={pageCss}>
			<header css={headCss}>
				<span
					aria-hidden="true"
					css={heroIconCss}
					style={
						{
							'--agent-icon': `url(${publicAsset(withAgentIconSrc(agent))})`,
						} as CSSProperties
					}
				></span>
				<h1>
					Kody for <em>{agent.name}</em>
				</h1>
				<p>{agent.pitch}</p>
			</header>

			<section aria-labelledby="with-connect-title" css={connectCss}>
				<h2 id="with-connect-title">Connect {agent.name}</h2>
				{agent.official ? null : (
					<p css={genericNoteCss}>
						{agent.note ?? (
							<>
								{agent.name} doesn&rsquo;t have an official Kody setup yet. It
								needs to support remote MCP servers; if it does, it can usually
								connect itself.
							</>
						)}
					</p>
				)}
				<ol>{agent.steps.map((step, index) => renderStep(step, index))}</ol>
				{agent.official ? (
					<div css={promptCss}>
						<p>Rather let {agent.name} handle it? Paste this setup prompt.</p>
						{renderPromptButton()}
					</div>
				) : null}
				<p css={moreCss}>
					<SiteLink href={docHref('connect-your-agent')}>
						More ways to connect
					</SiteLink>
				</p>
			</section>

			<section aria-labelledby="with-gets-title" css={sectionCss}>
				<h2 id="with-gets-title">What {agent.name} gets from Kody</h2>
				<ul css={primitivesCss}>
					{landingHomePrimitives.map((primitive) => (
						<li key={primitive.id}>
							<SiteLink href={primitiveFeatureHref(primitive.id)}>
								{primitive.word}
							</SiteLink>
							<p>{primitive.body}</p>
						</li>
					))}
				</ul>
			</section>

			<section aria-labelledby="with-team-title" css={sectionCss}>
				<h2 id="with-team-title">The rest of your team can join from</h2>
				<p css={teamLeadCss}>
					Everyone keeps the agent they like. They all reach the same
					credentials, packages, and workflows.
				</p>
				<ul css={othersCss}>{others.map((other) => renderOther(other))}</ul>
			</section>
		</article>
	)
}

function renderStep(step: WithAgentStep, index: number) {
	return (
		<li key={index}>
			<p>{step.text}</p>
			{step.prompt ? (
				<div css={stepPromptCss}>{renderPromptButton()}</div>
			) : null}
			{step.link ? (
				<SiteLink href={step.link.href} css={stepLinkCss}>
					{step.link.label} <span aria-hidden="true">↗</span>
				</SiteLink>
			) : null}
			{step.code ? (
				<div css={codeRowCss}>
					<pre>
						<code>{step.code}</code>
					</pre>
					<CopyTextButton
						value={step.code}
						variant="ghost"
						size="sm"
						idleLabel="Copy"
						copiedLabel="Copied"
						ariaLabel={`Copy step ${index + 1}`}
					/>
				</div>
			) : null}
		</li>
	)
}

function renderPromptButton() {
	return (
		<BuildWithAgentButton
			label="Copy setup prompt"
			variant="pill"
			onboardingPage={false}
			icons={false}
		/>
	)
}

function renderOther(agent: WithAgent) {
	return (
		<li key={agent.slug}>
			<SiteLink href={withAgentHref(agent.slug)}>
				<span
					aria-hidden="true"
					style={
						{
							'--agent-icon': `url(${publicAsset(withAgentIconSrc(agent))})`,
						} as CSSProperties
					}
				></span>
				{agent.name}
			</SiteLink>
		</li>
	)
}

const agentMaskCss = {
	display: 'block',
	backgroundColor: 'currentColor',
	mask: 'var(--agent-icon) center / contain no-repeat',
	WebkitMask: 'var(--agent-icon) center / contain no-repeat',
}

const pageCss = {
	maxWidth: '50rem',
	marginInline: 'auto',
	padding: `clamp(2.5rem, 6vw, 4rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
}

const headCss = {
	...pageHeadCss,
	display: 'grid',
	justifyItems: 'center',
	'& h1': {
		margin: '1.25rem 0 0',
		fontSize: 'clamp(2.1rem, 5vw, 3.2rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.06,
		textWrap: 'balance' as const,
	},
	'& h1 em': { fontStyle: 'normal', color: colors.primaryText },
	'& > p': {
		margin: '1rem 0 0',
		maxWidth: '38rem',
		fontSize: '1.1rem',
		lineHeight: 1.55,
		color: colors.textMuted,
		textWrap: 'pretty' as const,
	},
}

const heroIconCss = {
	...agentMaskCss,
	width: '96px',
	height: '96px',
	color: colors.text,
}

const sectionHeadingCss = {
	margin: 0,
	fontSize: '1.6rem',
	fontWeight: 720,
	letterSpacing: '-0.02em',
	lineHeight: 1.2,
}

const sectionCss = {
	marginTop: 'clamp(3rem, 7vw, 4.5rem)',
	'& h2': sectionHeadingCss,
}

const connectCss = {
	marginTop: 'clamp(2.5rem, 6vw, 3.5rem)',
	padding: 'clamp(1.25rem, 3vw, 2rem)',
	border: `1px solid ${colors.border}`,
	borderRadius: '1.25rem',
	background: colors.surface,
	'& h2': sectionHeadingCss,
	'& ol': {
		margin: '1.25rem 0 0',
		paddingLeft: '1.4rem',
		display: 'grid',
		// An auto track sizes to the longest command, so the field and Copy
		// spill past the card on every /with page that shares this list.
		gridTemplateColumns: 'minmax(0, 1fr)',
		gap: '1.1rem',
		minWidth: 0,
	},
	'& li': {
		minWidth: 0,
	},
	'& li::marker': { fontWeight: 700, color: colors.primaryText },
	'& li > p': { margin: 0, lineHeight: 1.55 },
}

const stepLinkCss = {
	display: 'inline-block',
	marginTop: '0.4rem',
	fontWeight: 600,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'underline' },
}

const codeRowCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'start',
	gap: '0.6rem',
	marginTop: '0.5rem',
	minWidth: 0,
	'& pre': {
		minWidth: 0,
		margin: 0,
		padding: '0.65rem 0.85rem',
		overflowX: 'auto' as const,
		border: `1px solid ${colors.border}`,
		borderRadius: '0.6rem',
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.85rem',
		lineHeight: 1.5,
	},
}

const genericNoteCss = {
	margin: '0.6rem 0 0',
	color: colors.textMuted,
	lineHeight: 1.55,
}

const stepPromptCss = {
	marginTop: '0.6rem',
}

const promptCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.75rem 1rem',
	marginTop: '1.5rem',
	paddingTop: '1.25rem',
	borderTop: `1px solid ${colors.border}`,
	'& p': { margin: 0, color: colors.textMuted },
}

const moreCss = {
	margin: '1rem 0 0',
	fontSize: '0.95rem',
	'& a': { color: colors.primaryText, fontWeight: 550 },
}

const primitivesCss = {
	listStyle: 'none',
	margin: '1.25rem 0 0',
	padding: 0,
	display: 'grid',
	gap: '1rem 1.5rem',
	gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
	'& a': {
		fontWeight: 700,
		fontSize: '1.05rem',
		textTransform: 'capitalize' as const,
		color: colors.text,
		textDecoration: 'none',
		'&:hover': { color: colors.primaryText },
	},
	'& p': {
		margin: '0.3rem 0 0',
		color: colors.textMuted,
		lineHeight: 1.5,
	},
}

const teamLeadCss = {
	margin: '0.6rem 0 0',
	color: colors.textMuted,
}

const othersCss = {
	listStyle: 'none',
	margin: '1.25rem 0 0',
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.6rem',
	'& a': {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '0.5rem',
		minHeight: '44px',
		padding: '0 0.9rem',
		border: `1px solid ${colors.border}`,
		borderRadius: '999px',
		color: colors.text,
		textDecoration: 'none',
		fontWeight: 550,
		'&:hover': { borderColor: colors.primaryText },
	},
	'& a > span': { ...agentMaskCss, width: '20px', height: '20px' },
}
