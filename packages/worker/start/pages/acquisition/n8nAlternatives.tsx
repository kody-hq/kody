/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { n8nAlternatives as page } from '#universal/acquisition/n8nAlternatives.ts'
import { routes } from '#universal/routes.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
const approaches = [
	{
		name: 'A visual workflow',
		product: 'Build the workflow by describing it.',
		reason:
			'Tell your agent which sources to read, what to change, and where the result should go. Kody keeps the implementation as code you can review and run again.',
		check:
			'Kody uses package code rather than a drag-and-drop workflow canvas.',
		artifact: 'Workflow canvas',
		steps: ['Trigger', 'Fetch releases', 'Filter + group', 'Post to Slack'],
	},
	{
		name: 'Reusable agent tools',
		product: 'Try the job as a Kody package.',
		reason:
			'Choose this when you want to describe work to your agent, keep the working code, and call it again from another connected agent.',
		check:
			'Check the connections, code, runtime limits, and what you need to save between runs.',
		artifact: 'release-digest package',
		steps: [
			'Connected accounts',
			'Reviewed code',
			'Stored progress',
			'Agent or schedule',
		],
	},
	{
		name: 'Internal scripts and apps',
		product: 'Save your script as a Kody tool.',
		reason:
			'Turn a useful script into a package your agents can call. Keep its service connections and progress in Kody, then add a schedule when you need one.',
		check:
			'Review the package code and try a small run before using it for recurring work.',
		artifact: 'Script-based workflow',
		steps: [
			'Script inputs',
			'Fetch + transform',
			'Run history',
			'Internal tool',
		],
	},
] as const
export function N8nAlternativesPage() {
	const [selected, setSelected] = useState(1)
	const approach = approaches[selected]!
	return (
		<article css={styles}>
			<header className="opening">
				<h1>{page.title}</h1>
				<div className="opening-copy">
					<p>Build it with your agent, keep it in Kody.</p>
					<p>
						Describe the job, let your agent build the code, and keep the
						workflow ready for next time. Your connected accounts, saved
						progress, and schedule stay with it.
					</p>
					<SiteLink href="#choose">
						Find your approach <span aria-hidden="true">↓</span>
					</SiteLink>
				</div>
			</header>

			<section className="decision" id="choose" aria-labelledby="choose-title">
				<div className="decision-controls">
					<h2 id="choose-title">What are you building?</h2>
					<div role="group" aria-label="Choose what you want to maintain">
						{approaches.map((item, index) => (
							<button
								key={item.name}
								type="button"
								aria-pressed={selected === index ? 'true' : 'false'}
								onClick={() => {
									setSelected(index)
								}}
							>
								{item.name}
								<span aria-hidden="true">↗</span>
							</button>
						))}
					</div>
				</div>
				<div className="recommendation" aria-live="polite">
					<div
						className="artifact"
						aria-label={`${approach.artifact} example structure`}
					>
						<span className="artifact-name">{approach.artifact}</span>
						<ol>
							{approach.steps.map((step) => (
								<li key={step}>{step}</li>
							))}
						</ol>
					</div>
					<h3>{approach.product}</h3>
					<p>{approach.reason}</p>
					<p className="check">{approach.check}</p>
				</div>
			</section>

			<section className="shortlist" aria-labelledby="shortlist-title">
				<h2 id="shortlist-title">Compare the tradeoffs.</h2>
				<div className="comparison">
					<table>
						<thead>
							<tr>
								{page.sections[0]!.table!.headers.map((heading) => (
									<th scope="col" key={heading}>
										{heading}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{page.sections[0]!.table!.rows.map((row) => (
								<tr key={row[0]}>
									{row.map((cell, index) =>
										index === 0 ? (
											<th scope="row" key={cell}>
												{cell}
											</th>
										) : (
											<td key={cell}>{cell}</td>
										),
									)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="notice">
					<strong>Evaluating Pipedream?</strong> Workflows is closed to new
					signups and is scheduled to shut down March 31, 2027. Connect is
					unaffected.{' '}
					<SiteLink href="https://pipedream.com/docs/workflows">
						Read the shutdown notice
					</SiteLink>
					.
				</p>
			</section>

			<section className="trial" aria-labelledby="trial-title">
				<div className="trial-brief">
					<h2 id="trial-title">Build your release digest in Kody.</h2>
					<p>
						Collect GitHub releases, group them by project, and put together a
						Slack digest with links.
					</p>
					<p>
						Start with a preview, then ask your agent to add a repository or
						change the channel. Save the working version as a package and give
						it a schedule.
					</p>
					<div className="brief-output">
						<strong>Release digest</strong>
						<dl>
							<div>
								<dt>Read from</dt>
								<dd>Selected GitHub repositories</dd>
							</div>
							<div>
								<dt>Return first</dt>
								<dd>A preview, without posting</dd>
							</div>
							<div>
								<dt>Track in package storage</dt>
								<dd>Releases already handled</dd>
							</div>
							<div>
								<dt>Enable last</dt>
								<dd>The recurring schedule</dd>
							</div>
						</dl>
					</div>
				</div>
				<ol className="evaluation">
					<li>
						<h3>Check the first result.</h3>
						<p>
							Run manually without posting. Verify the repositories, time
							window, and source links.
						</p>
					</li>
					<li>
						<h3>Run it again.</h3>
						<p>
							Can it recognize releases already handled? Decide what happens to
							that progress when a Slack post fails.
						</p>
					</li>
					<li>
						<h3>Change the request.</h3>
						<p>
							Exclude prereleases, add a repository, and change the destination.
							Review what needs editing.
						</p>
					</li>
					<li>
						<h3>Break a connection.</h3>
						<p>
							Test an expired connection before enabling the schedule. Check how
							much work it takes to recover, too.
						</p>
					</li>
				</ol>
			</section>

			<section className="verdict">
				<div>
					<h2>Keep the useful work.</h2>
					{page.sections[2]!.paragraphs.map((text) => (
						<p key={text}>{text}</p>
					))}
				</div>
				<div>
					<h2>Keep improving the same workflow.</h2>
					{page.sections[3]!.paragraphs.map((text) => (
						<p key={text}>{text}</p>
					))}
				</div>
			</section>
			<section className="start" id="try-it">
				<div>
					<h2>Try the release digest in Kody.</h2>
					<p>
						Connect your agent, then give it this brief. Review the setup and
						permissions before running it.
					</p>
					<SiteLink className="primary" href={routes.onboarding.href()}>
						Connect your agent <span aria-hidden="true">↗</span>
					</SiteLink>
					<SiteLink className="pricing" href={routes.pricing.href()}>
						Check pricing and limits
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
			<footer className="reading">
				<h2>Documentation</h2>
				<div>
					{page.sources.map((source) => (
						<SiteLink key={source.href} href={source.href}>
							{source.label} <span aria-hidden="true">↗</span>
						</SiteLink>
					))}
				</div>
				<nav aria-label="Related workflows">
					<SiteLink href="/use-cases/scheduled-workflows">
						Scheduling a reusable workflow
					</SiteLink>
					<SiteLink href="/use-cases/claude-code-custom-tools">
						Building custom agent tools
					</SiteLink>
					<SiteLink href="/use-cases/ai-workflow-automation">
						AI workflow automation
					</SiteLink>
				</nav>
			</footer>
		</article>
	)
}
const styles = {
	maxWidth: '1200px',
	marginInline: 'auto',
	padding: '4.5rem 2rem 5rem',
	color: colors.text,
	'& *': { boxSizing: 'border-box' },
	'& h1, & h2, & h3': {
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: 600,
		margin: 0,
		textWrap: 'balance',
	},
	'& h1': { fontSize: '4.7rem', lineHeight: 1.02, maxWidth: '12ch' },
	'& h2': { fontSize: '2.35rem', lineHeight: 1.12 },
	'& h3': { fontSize: '1.4rem', lineHeight: 1.2 },
	'& p': { lineHeight: 1.7, color: colors.textMuted },
	'& button:focus-visible, & a:focus-visible': {
		outline: `3px solid ${colors.primaryText}`,
		outlineOffset: '5px',
	},
	'& .opening': {
		display: 'grid',
		gridTemplateColumns: '1.15fr 1fr',
		gap: '4rem',
		alignItems: 'end',
		paddingBottom: '3.5rem',
	},
	'& .opening-copy > p:first-child': {
		color: colors.text,
		fontSize: '1.55rem',
		lineHeight: 1.3,
		marginTop: 0,
	},
	'& .opening-copy > p': { fontSize: '1.1rem', maxWidth: '32rem' },
	'& .opening-copy > a': { display: 'inline-block', marginTop: '0.75rem' },
	'& .decision': {
		scrollMarginTop: '6rem',
		display: 'grid',
		gridTemplateColumns: '0.85fr 1.3fr',
		borderBlock: `1px solid ${colors.border}`,
	},
	'& .decision-controls': { padding: '2.5rem 2.5rem 2.5rem 0' },
	'& .decision-controls h2': { fontSize: '1.65rem', marginBottom: '2rem' },
	'& .decision-controls button': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		width: '100%',
		textAlign: 'left',
		background: 'transparent',
		color: colors.textMuted,
		border: 0,
		borderBottom: `1px solid ${colors.border}`,
		padding: '1.2rem 0.9rem',
		font: 'inherit',
		cursor: 'pointer',
	},
	'& .decision-controls button[aria-pressed="true"]': {
		background: colors.primarySoft,
		color: colors.primaryText,
		fontWeight: 600,
	},
	'& .recommendation': {
		padding: '2.5rem',
		background: colors.surface,
		borderLeft: `1px solid ${colors.border}`,
	},
	'& .recommendation p': { marginBottom: 0 },
	'& .recommendation .check': {
		fontSize: '0.9rem',
		borderTop: `1px solid ${colors.border}`,
		paddingTop: '1rem',
	},
	'& .artifact': {
		marginBottom: '2rem',
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.8rem',
	},
	'& .artifact-name': {
		display: 'block',
		paddingBottom: '0.75rem',
		color: colors.primaryText,
	},
	'& .artifact ol': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '1px',
		background: colors.border,
		border: `1px solid ${colors.border}`,
		listStyle: 'none',
		padding: 0,
		margin: 0,
	},
	'& .artifact li': { padding: '0.8rem', background: colors.background },
	'& .shortlist': { paddingBlock: '4rem' },
	'& .comparison': { overflowX: 'auto', marginTop: '2rem' },
	'& table': { width: '100%', borderCollapse: 'collapse', lineHeight: 1.6 },
	'& th, & td': {
		textAlign: 'left',
		verticalAlign: 'top',
		padding: '1.25rem 1.25rem 1.25rem 0',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& thead th': {
		fontSize: '0.85rem',
		color: colors.textMuted,
		fontWeight: 500,
	},
	'& tbody th': { minWidth: '10rem', fontSize: '1.1rem' },
	'& td': { minWidth: '13rem', color: colors.textMuted },
	'& .notice': {
		borderLeft: `3px solid ${colors.warningText}`,
		paddingLeft: '1rem',
		fontSize: '0.9rem',
		marginTop: '1.5rem',
		maxWidth: '55rem',
	},
	'& .trial': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingBlock: '3rem',
		borderBlock: `1px solid ${colors.border}`,
	},
	'& .trial-brief h2': { maxWidth: '15ch' },
	'& .brief-output': {
		marginTop: '2rem',
		border: `1px solid ${colors.border}`,
		padding: '1.5rem',
		background: colors.surface,
	},
	'& .brief-output > strong': {
		fontFamily: typography.fontFamilyMono,
		fontWeight: 500,
	},
	'& dl': { marginBottom: 0, fontSize: '0.9rem' },
	'& dl > div': {
		display: 'grid',
		gridTemplateColumns: '6rem 1fr',
		gap: '1rem',
		paddingBlock: '0.55rem',
	},
	'& dt': { color: colors.textMuted },
	'& dd': { margin: 0 },
	'& .evaluation': {
		listStyle: 'decimal-leading-zero',
		paddingLeft: '2.4rem',
		margin: 0,
	},
	'& .evaluation li': { padding: '0 0 1.5rem 0.8rem' },
	'& .evaluation li::marker': {
		fontFamily: typography.fontFamilyMono,
		color: colors.primaryText,
	},
	'& .evaluation p': { marginBottom: 0 },
	'& .verdict': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingBlock: '4rem',
	},
	'& .verdict h2': { fontSize: '1.9rem' },
	'& .start': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.15fr',
		gap: '3rem',
		padding: '2.5rem',
		background: colors.primarySoftest,
		borderBlock: `1px solid ${colors.border}`,
	},
	'& .start h2': { fontSize: '2rem' },
	'& .primary': {
		display: 'inline-flex',
		gap: '1rem',
		background: colors.primary,
		color: colors.onPrimary,
		padding: '0.85rem 1.1rem',
		borderRadius: '0.4rem',
		textDecoration: 'none',
		fontWeight: 600,
	},
	'& .pricing': {
		display: 'block',
		width: 'fit-content',
		marginTop: '1rem',
		fontSize: '0.9rem',
	},
	'& blockquote': {
		margin: '0 0 1.5rem',
		fontSize: '1.05rem',
		lineHeight: 1.7,
	},
	'& .reading': { paddingTop: '3rem' },
	'& .reading h2': { fontSize: '1.4rem', marginBottom: '1rem' },
	'& .reading > div, & .reading nav': {
		display: 'flex',
		flexWrap: 'wrap',
		columnGap: '1.5rem',
		rowGap: '0.8rem',
		fontSize: '0.9rem',
	},
	'& .reading nav': {
		marginTop: '2rem',
		borderTop: `1px solid ${colors.border}`,
		paddingTop: '1.5rem',
	},
	'@media (max-width: 760px)': {
		padding: '2.5rem 1.25rem 3rem',
		'& h1': { fontSize: '3.1rem' },
		'& h2': { fontSize: '2rem' },
		'& .opening': {
			gridTemplateColumns: '1fr',
			gap: '1.5rem',
			paddingBottom: '2rem',
		},
		'& .opening-copy > p:first-child': { fontSize: '1.3rem' },
		'& .decision, & .trial, & .verdict, & .start': {
			gridTemplateColumns: '1fr',
			gap: '2rem',
		},
		'& .decision': { gap: 0 },
		'& .decision-controls': { padding: '1.5rem 0' },
		'& .decision-controls h2': { marginBottom: '1rem' },
		'& .recommendation': {
			padding: '1.5rem',
			borderLeft: 0,
			borderTop: `1px solid ${colors.border}`,
		},
		'& .shortlist, & .verdict': { paddingBlock: '2.5rem' },
		'& .start': { padding: '1.5rem' },
		'& .trial': { paddingBlock: '2.5rem' },
		'& .trial-brief h2': { maxWidth: 'none' },
	},
} as const
