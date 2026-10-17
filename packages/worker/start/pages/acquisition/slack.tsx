/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { slack } from '#universal/acquisition/slack.ts'
import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
const releases = [
	{
		repo: 'acme/web',
		version: 'v2.4.0',
		summary: 'Saved filters for the activity feed',
		id: 'release_104',
	},
	{
		repo: 'acme/api',
		version: 'v1.8.2',
		summary: 'Retry handling for incoming webhooks',
		id: 'release_105',
	},
	{
		repo: 'acme/docs',
		version: 'v3.1.0',
		summary: 'New workspace setup guide',
		id: 'release_106',
	},
]
export function SlackPage() {
	const [selected, setSelected] = useState([true, true, false])
	const [repeated, setRepeated] = useState(false)
	const included = releases.filter((_, index) => selected[index])
	return (
		<article css={pageCss}>
			<header className="hero">
				<h1>{slack.title}</h1>
				<div className="hero-copy">
					<p>
						Put the update together once, then let your saved workflow handle
						the next one. Include the source links and keep track of what’s
						already been posted.
					</p>
					<SiteLink href="#try-it" css={getPillButtonCss()}>
						Build your Slack workflow
					</SiteLink>
				</div>
			</header>
			<section className="digest" aria-label="Example GitHub release digest">
				<div className="demo-heading">
					<strong>Example release digest</strong>
					<span>Sample data. Nothing is sent.</span>
				</div>
				<div className="digest-layout">
					<div className="sources">
						<h2>Choose the sources</h2>
						<p>Include a repository in the channel preview.</p>
						<div
							className="source-list"
							role="group"
							aria-label="Repositories in the digest"
						>
							{releases.map((release, index) => (
								<button
									key={release.id}
									type="button"
									aria-pressed={selected[index] ? 'true' : 'false'}
									onClick={() => {
										setSelected(
											selected.map((value, item) =>
												item === index ? !value : value,
											),
										)
										setRepeated(false)
									}}
								>
									<span className="selection" aria-hidden="true">
										{selected[index] ? '✓' : '+'}
									</span>
									<span>
										<strong>{release.repo}</strong>
										<small>{release.version}</small>
									</span>
								</button>
							))}
						</div>
						<p className="rule">
							Published releases only
							<br />
							Already handled items excluded
						</p>
					</div>
					<div className="channel" aria-live="polite">
						<div className="channel-heading">
							<strong># engineering-updates</strong>
							<span>Message preview</span>
						</div>
						<div className="message">
							<span className="avatar" aria-hidden="true">
								k
							</span>
							<div className="message-content">
								<strong>
									Kody <span className="app-label">APP</span>
								</strong>
								<p className="message-title">Release roundup</p>
								{included.length ? (
									<ul>
										{included.map((release) => (
											<li key={release.id}>
												<strong>
													{release.repo} · {release.version}
												</strong>
												<p>{release.summary}</p>
												<span className="source-reference">
													github.com/{release.repo}/releases/tag/
													{release.version}
												</span>
											</li>
										))}
									</ul>
								) : (
									<p>Select a repository to prepare a digest.</p>
								)}
							</div>
						</div>
						<div className="preview-footer">
							Source links travel with each release.
						</div>
					</div>
				</div>
			</section>
			<section className="checkpoint">
				<div className="checkpoint-copy">
					<h2>The second run matters, too.</h2>
					<p>
						Save which releases you’ve already posted in the package, then try
						running it again with the same releases.
					</p>
					<p>
						This example assumes the first message was sent and its release IDs
						were saved successfully.
					</p>
					<button
						className="run-button"
						type="button"
						disabled={included.length === 0}
						onClick={() => {
							setRepeated(!repeated)
						}}
					>
						{repeated ? 'Reset example' : 'Simulate the next run'}{' '}
						<span aria-hidden="true">↗</span>
					</button>
				</div>
				<div className="run-log" aria-live="polite">
					<div className="log-row">
						<span>Stored release IDs</span>
						<code>
							{included.length
								? included.map((release) => release.id).join('\n')
								: 'none selected'}
						</code>
					</div>
					<div className="log-row">
						<span>Next input</span>
						<strong>The same selected releases</strong>
					</div>
					<div className="log-result">
						<span>{repeated ? 'Next run result' : 'Ready to simulate'}</span>
						<strong>
							{repeated
								? 'No new releases. No message.'
								: 'Compare input with saved progress.'}
						</strong>
					</div>
				</div>
				<p className="failure-note">
					<strong>What if the message sends but saving progress fails?</strong>{' '}
					Decide how the package should check for a previous post before trying
					again. Saving progress alone won’t prevent every duplicate.
				</p>
			</section>
			<section className="build">
				<h2>Get your release digest running.</h2>
				<ol>
					<li>
						<strong>Connect the accounts</strong>
						<p>
							Choose repositories and a channel your accounts can access. Kody
							doesn’t expand your Slack permissions.
						</p>
					</li>
					<li>
						<strong>Review one message</strong>
						<p>
							Return a preview first. Check the time window, source links, and
							exclusions, then approve one test send.
						</p>
					</li>
					<li>
						<strong>Give the package a schedule</strong>
						<p>
							After testing retries and empty results, add a package-owned job.
							Use run history to investigate connection and service failures.
						</p>
					</li>
				</ol>
			</section>
			<section className="choice">
				<h2>Already using Slack MCP?</h2>
				<div>
					<p>
						Direct Slack MCP access can give one agent the service’s tools. A
						Kody package adds your saved selection rules, other services’ data,
						and saved progress.
					</p>
					<p>
						Connecting Slack as an integration and adding a remote MCP server
						are separate setups. Choose the connection your workflow needs.
					</p>
					<SiteLink href="/docs/slack">
						Read the Slack connection guide ↗
					</SiteLink>
				</div>
			</section>
			<section id="try-it" className="start">
				<div>
					<h2>Try it with your Slack channel.</h2>
					<p>
						Connect your agent to Kody, then use this prompt to start building
						the package.
					</p>
					<SiteLink href="/onboarding" css={getPillButtonCss()}>
						Connect your agent
					</SiteLink>
				</div>
				<div className="prompt">
					<blockquote>{slack.prompt}</blockquote>
					<CopyTextButton
						value={slack.prompt}
						idleLabel="Copy prompt"
						variant="pill"
					/>
				</div>
			</section>
			<nav className="reading" aria-label="Slack workflow resources">
				{slack.sources.map((source) => (
					<SiteLink key={source.href} href={source.href}>
						{source.label} ↗
					</SiteLink>
				))}
				{[
					acquisitionPageMeta.scheduledWorkflows,
					acquisitionPageMeta.gmail,
					acquisitionPageMeta.customTools,
				].map((page) => (
					<SiteLink key={page.key} href={page.path}>
						{page.title} ↗
					</SiteLink>
				))}
			</nav>
		</article>
	)
}
const pageCss = {
	maxWidth: '1180px',
	margin: '0 auto',
	padding: '4rem 2rem 5rem',
	color: colors.text,
	'& *': { boxSizing: 'border-box' as const },
	'& h1, & h2, & h3, & p': { margin: 0 },
	'& h1, & h2': { fontFamily: typography.fontFamilyDisplay, fontWeight: 500 },
	'& h1': { fontSize: '4.5rem', lineHeight: 1.06, maxWidth: '820px' },
	'& h2': { fontSize: '2.4rem', lineHeight: 1.15 },
	'& p': { lineHeight: 1.75 },
	'& button:focus-visible, & a:focus-visible': {
		outline: '3px solid light-dark(#b87930, var(--color-field-border))',
		outlineOffset: '4px',
	},
	'& .hero-copy': {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '3rem',
		marginTop: '2rem',
		marginBottom: '3rem',
	},
	'& .hero-copy p': {
		maxWidth: '620px',
		fontSize: '1.12rem',
		color: colors.textMuted,
	},
	'& .hero-copy a': { flexShrink: 0 },
	'& .digest': {
		border: '1px solid light-dark(#ccd5d2, var(--color-border))',
		borderRadius: '10px',
		overflow: 'hidden',
		color: 'light-dark(#243632, var(--color-text))',
		background: 'light-dark(#fffefa, var(--color-surface))',
	},
	'& .demo-heading': {
		padding: '1rem 1.5rem',
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		background: 'light-dark(#233e36, var(--color-surface))',
		color: 'light-dark(#f4f5e9, var(--color-text))',
		fontSize: '0.85rem',
	},
	'& .digest-layout': {
		display: 'grid',
		gridTemplateColumns: '300px minmax(0, 1fr)',
	},
	'& .sources': {
		padding: '1.5rem',
		background: 'light-dark(#edf0e9, var(--color-surface))',
		borderRight: '1px solid light-dark(#ccd5d2, var(--color-border))',
	},
	'& .sources h2': { fontSize: '1.25rem', marginBottom: '0.5rem' },
	'& .sources p': {
		fontSize: '0.85rem',
		color: 'light-dark(#51645d, var(--color-text-muted))',
	},
	'& .source-list': { display: 'grid', gap: '0.5rem', marginTop: '1.5rem' },
	'& .source-list button': {
		display: 'flex',
		alignItems: 'center',
		gap: '0.75rem',
		padding: '0.85rem',
		border: '1px solid light-dark(#c4cfc5, var(--color-border))',
		borderRadius: '4px',
		textAlign: 'left' as const,
		font: 'inherit',
		color: 'light-dark(#243632, var(--color-text))',
		background: 'transparent',
		cursor: 'pointer',
	},
	'& .source-list button[aria-pressed="true"]': {
		background:
			'light-dark(#fffefa, color-mix(in srgb, var(--color-primary) 12%, var(--color-surface)))',
		borderColor: 'light-dark(#315c4d, var(--color-border))',
	},
	'& .source-list small': {
		display: 'block',
		color: 'light-dark(#51645d, var(--color-text-muted))',
		marginTop: '0.2rem',
	},
	'& .selection': {
		width: '22px',
		height: '22px',
		border: '1px solid light-dark(#a8baad, var(--color-border))',
		display: 'grid',
		placeItems: 'center',
		borderRadius: '3px',
	},
	'& .rule': { marginTop: '1.5rem' },
	'& .channel': {
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column' as const,
	},
	'& .channel-heading': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		justifyContent: 'space-between',
		gap: '0.5rem',
		padding: '1rem 1.5rem',
		borderBottom: '1px solid light-dark(#e3e5de, var(--color-border))',
	},
	'& .channel-heading span': {
		fontSize: '0.8rem',
		color: 'light-dark(#62716c, var(--color-text-muted))',
	},
	'& .message': {
		display: 'flex',
		gap: '1rem',
		padding: '1.5rem',
		minHeight: '340px',
	},
	'& .avatar': {
		flexShrink: 0,
		width: '36px',
		height: '36px',
		display: 'grid',
		placeItems: 'center',
		borderRadius: '7px',
		color: 'light-dark(#edf7c0, var(--color-text))',
		background: 'light-dark(#315c4d, var(--color-surface))',
		fontSize: '1.5rem',
		fontWeight: 700,
	},
	'& .message-content': { minWidth: 0, fontSize: '0.9rem' },
	'& .app-label': {
		fontSize: '0.65rem',
		background: 'light-dark(#e7eae4, var(--color-background))',
		padding: '2px 4px',
		marginLeft: '0.4rem',
		borderRadius: '3px',
	},
	'& .message-title': { marginTop: '1rem', fontWeight: 600 },
	'& .message ul': { padding: 0, listStyle: 'none', margin: '1rem 0' },
	'& .message li': {
		paddingLeft: '1rem',
		borderLeft: '3px solid light-dark(#bad480, var(--color-border))',
		marginBottom: '1.25rem',
	},
	'& .message li p': { lineHeight: 1.5, marginTop: '0.2rem' },
	'& .source-reference': {
		display: 'block',
		color: 'light-dark(#31695c, var(--color-text-muted))',
		fontSize: '0.75rem',
		marginTop: '0.4rem',
		overflowWrap: 'anywhere' as const,
	},
	'& .preview-footer': {
		padding: '0.8rem 1.5rem',
		marginTop: 'auto',
		borderTop: '1px solid light-dark(#e3e5de, var(--color-border))',
		fontSize: '0.8rem',
		color: 'light-dark(#62716c, var(--color-text-muted))',
	},
	'& .checkpoint': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '2rem 4rem',
		paddingBlock: '5rem',
	},
	'& .checkpoint-copy p': { marginTop: '1rem', color: colors.textMuted },
	'& .run-button': {
		marginTop: '1.5rem',
		display: 'flex',
		gap: '2rem',
		alignItems: 'center',
		padding: '0.8rem 1rem',
		border: `1px solid ${colors.border}`,
		background: colors.surface,
		color: colors.text,
		font: 'inherit',
		cursor: 'pointer',
		borderRadius: '4px',
	},
	'& .run-button:disabled': { opacity: 0.5, cursor: 'default' },
	'& .run-log': { borderTop: `2px solid ${colors.text}`, paddingTop: '0.5rem' },
	'& .log-row, & .log-result': {
		padding: '1.25rem 0',
		borderBottom: `1px solid ${colors.border}`,
		display: 'grid',
		gap: '0.5rem',
	},
	'& .log-row span, & .log-result span': {
		fontSize: '0.8rem',
		color: colors.textMuted,
	},
	'& .log-row code': {
		whiteSpace: 'pre-wrap' as const,
		fontSize: '0.85rem',
		lineHeight: 1.7,
	},
	'& .log-result': { borderBottom: 0 },
	'& .failure-note': {
		gridColumn: '1 / -1',
		fontSize: '0.88rem',
		paddingLeft: '1rem',
		borderLeft: '3px solid light-dark(#b87930, var(--color-border))',
		color: colors.textMuted,
	},
	'& .build': { borderTop: `1px solid ${colors.border}`, paddingBlock: '3rem' },
	'& .build ol': {
		listStyle: 'none',
		counterReset: 'step',
		padding: 0,
		margin: '2rem 0 0',
	},
	'& .build li': {
		counterIncrement: 'step',
		display: 'grid',
		gridTemplateColumns: '2rem 240px 1fr',
		alignItems: 'baseline',
		gap: '1.5rem',
		paddingBlock: '1.5rem',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .build li::before': {
		content: 'counter(step)',
		fontFamily: typography.fontFamilyDisplay,
		fontSize: '1.5rem',
		color: colors.textMuted,
	},
	'& .build li p': { color: colors.textMuted },
	'& .choice': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingBlock: '2rem 4rem',
	},
	'& .choice p': { marginBottom: '1rem', color: colors.textMuted },
	'& .start': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingTop: '3rem',
		borderTop: `1px solid ${colors.border}`,
		scrollMarginTop: '6rem',
	},
	'& .start p': { marginBlock: '1rem 1.5rem', color: colors.textMuted },
	'& .prompt': {
		borderLeft: '3px solid light-dark(#315c4d, var(--color-border))',
		paddingLeft: '1.5rem',
	},
	'& blockquote': { margin: '0 0 1.5rem', lineHeight: 1.75 },
	'& .reading': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '1rem 2rem',
		marginTop: '3rem',
		fontSize: '0.85rem',
	},
	'@media (max-width: 760px)': {
		padding: '2rem 1.25rem 3rem',
		'& h1': { fontSize: '2.8rem' },
		'& h2': { fontSize: '2rem' },
		'& .hero-copy': {
			flexDirection: 'column' as const,
			alignItems: 'start',
			gap: '1.5rem',
		},
		'& .demo-heading': { flexDirection: 'column' as const, gap: '0.25rem' },
		'& .digest-layout, & .checkpoint, & .choice, & .start': {
			gridTemplateColumns: '1fr',
			gap: '2rem',
		},
		'& .sources': {
			borderRight: 0,
			borderBottom: '1px solid light-dark(#ccd5d2, var(--color-border))',
			padding: '1.25rem',
		},
		'& .source-list': {
			gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			gap: '0.35rem',
			marginTop: '1rem',
		},
		'& .source-list button': {
			flexDirection: 'column' as const,
			alignItems: 'start',
			fontSize: '0.7rem',
			padding: '0.6rem',
			gap: '0.5rem',
		},
		'& .rule': { marginTop: '1rem' },
		'& .message': { padding: '1.25rem', gap: '0.7rem' },
		'& .message-content': { fontSize: '0.8rem' },
		'& .channel-heading': { padding: '1rem 1.25rem' },
		'& .checkpoint': { paddingBlock: '3rem' },
		'& .build li': { gridTemplateColumns: '1.5rem 1fr', gap: '0.5rem 1rem' },
		'& .build li p': { gridColumn: '2' },
		'& .choice': { paddingBlock: '1rem 3rem' },
	},
}
