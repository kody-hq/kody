/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { automation } from '#universal/acquisition/automation.ts'
import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
const examples = [
	{
		name: 'Release digest',
		request: 'Tell me which releases matter to my project.',
		input: 'GitHub releases + project context',
		steps: [
			{
				kind: 'Code',
				title: 'Collect new releases',
				detail:
					'Read the selected repositories and skip release IDs already processed.',
			},
			{
				kind: 'Judgment',
				title: 'Explain the impact',
				detail:
					'Ask a model which changes affect the project, with links back to the source.',
			},
			{
				kind: 'Code',
				title: 'Format a preview',
				detail:
					'Build the digest and return it for review before enabling Slack posts.',
			},
		],
		output: 'A digest with source links',
		state: 'Processed release IDs',
		review: 'Check the relevance and source links before posting.',
	},
	{
		name: 'Inbox triage',
		request: 'Find the emails that need a thoughtful reply.',
		input: 'Gmail messages + package settings',
		steps: [
			{
				kind: 'Code',
				title: 'Collect matching messages',
				detail:
					'Apply your mailbox query and load the threads that have not been processed.',
			},
			{
				kind: 'Judgment',
				title: 'Draft the response',
				detail:
					'Use the thread and the package’s reply settings to suggest a reply. Flag missing information.',
			},
			{
				kind: 'Code',
				title: 'Save a draft',
				detail:
					'Create a draft for review, keep its ID, and avoid creating another on a repeated run.',
			},
		],
		output: 'Draft replies, ready for review',
		state: 'Thread and draft IDs',
		review: 'You review the wording and choose whether to send.',
	},
	{
		name: 'Weekly report',
		request: 'Show me what changed since last week.',
		input: 'Connected data sources + previous snapshot',
		steps: [
			{
				kind: 'Code',
				title: 'Calculate the changes',
				detail:
					'Fetch the selected data, compare it with the previous snapshot, and calculate deltas.',
			},
			{
				kind: 'Judgment',
				title: 'Investigate what matters',
				detail:
					'Ask a model to explain notable changes. Keep source data beside its interpretation.',
			},
			{
				kind: 'Code',
				title: 'Save the report',
				detail:
					'Store the output and checkpoint so the next report can use the same comparison window.',
			},
		],
		output: 'A report you can check against the data',
		state: 'Snapshot and reporting window',
		review: 'Verify the explanation before acting on the report.',
	},
]
const groups = [
	{
		title: 'Start with the work',
		keys: ['gmail', 'slack', 'scheduledWorkflows'] as const,
	},
	{
		title: 'Give your agents a foundation',
		keys: [
			'customTools',
			'sharedMemory',
			'mcpGateway',
			'claudeIntegrations',
		] as const,
	},
	{
		title: 'Compare your options',
		keys: ['n8nAlternatives', 'composioAlternatives'] as const,
	},
]
export function AutomationPage() {
	const [selected, setSelected] = useState(0)
	const example = examples[selected]!
	return (
		<article css={pageCss}>
			<header className="hero">
				<h1>{automation.title}</h1>
				<div className="intro">
					<p>Build it with an agent. Keep the parts that work.</p>
					<p>
						Kody gives your agents a home for saved code, connected accounts,
						memory, and background work. Decide where each workflow needs
						judgment and where it just needs to run.
					</p>
					<SiteLink href="#try-it" css={getPillButtonCss()}>
						Build your first workflow ↗
					</SiteLink>
				</div>
			</header>
			<section className="anatomy" aria-label="Interactive workflow examples">
				<div className="example-bar">
					<strong>Example workflow</strong>
					<span>Illustration only, nothing runs here.</span>
				</div>
				<div className="choices" role="group" aria-label="Choose a workflow">
					{examples.map((item, index) => (
						<button
							key={item.name}
							type="button"
							aria-pressed={selected === index ? 'true' : 'false'}
							onClick={() => {
								setSelected(index)
							}}
						>
							{item.name}
						</button>
					))}
				</div>
				<div className="workbench" aria-live="polite">
					<div className="request">
						<h2>{example.request}</h2>
						<dl>
							<dt>Input</dt>
							<dd>{example.input}</dd>
							<dt>Saved progress</dt>
							<dd>{example.state}</dd>
						</dl>
					</div>
					<ol className="pipeline">
						{example.steps.map((step, index) => (
							<li key={step.title} data-kind={step.kind}>
								<div className="step-top">
									<span className="sequence" aria-hidden="true">
										0{index + 1}
									</span>
									<span className="kind">{step.kind}</span>
								</div>
								<h3>{step.title}</h3>
								<p>{step.detail}</p>
							</li>
						))}
					</ol>
					<div className="result">
						<span>Output</span>
						<strong>{example.output}</strong>
						<p>{example.review}</p>
					</div>
				</div>
			</section>
			<section className="boundary">
				<h2>
					Spend reasoning
					<br />
					where it matters.
				</h2>
				<div>
					<p>
						You don’t need a model to fetch releases and format links. Figuring
						out which changes affect your project is a better use for it. Keep
						those steps separate so you can check the code and the AI’s answer.
					</p>
					<p>
						A saved package can run from a job or webhook without a chat
						session. If your code calls a model, you’ll need to account for that
						usage and cost, too.
					</p>
					<SiteLink href="/docs/triggers">
						How jobs and workflows run ↗
					</SiteLink>
				</div>
			</section>
			<nav className="directory" aria-label="Workflow guides">
				<h2>Find your starting point.</h2>
				{groups.map((group) => (
					<div className="directory-group" key={group.title}>
						<h3>{group.title}</h3>
						<ul>
							{group.keys.map((key) => {
								const page = acquisitionPageMeta[key]
								return (
									<li key={key}>
										<SiteLink href={page.path}>
											<span>{page.title}</span>
											<span aria-hidden="true">↗</span>
										</SiteLink>
									</li>
								)
							})}
						</ul>
					</div>
				))}
			</nav>
			<section className="start" id="try-it">
				<div>
					<h2>
						One useful output.
						<br />
						Then build from there.
					</h2>
					<p>
						Connect the required accounts, try a manual preview, and test
						failures and repeated runs before adding a schedule.
					</p>
					<SiteLink href="/onboarding" css={getPillButtonCss()}>
						Get started with Kody ↗
					</SiteLink>
				</div>
				<div className="prompt">
					<h3>Copy this prompt to your agent</h3>
					<blockquote>{automation.prompt}</blockquote>
					<CopyTextButton
						value={automation.prompt}
						idleLabel="Copy prompt"
						variant="pill"
					/>
				</div>
			</section>
			<div className="reading">
				{automation.sources.map((source) => (
					<SiteLink key={source.href} href={source.href}>
						{source.label}
					</SiteLink>
				))}
			</div>
		</article>
	)
}
const pageCss = {
	maxWidth: '1240px',
	marginInline: 'auto',
	padding: '4rem 2.5rem 5rem',
	color: colors.text,
	fontFamily: typography.fontFamilyBody,
	lineHeight: 1.65,
	'& *': { boxSizing: 'border-box' as const },
	'& h1, & h2, & h3, & p': { margin: 0 },
	'& h1, & h2, & h3': {
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: 500,
	},
	'& h1': { fontSize: '4.4rem', lineHeight: 1.04, maxWidth: '12ch' },
	'& h2': { fontSize: '2.7rem', lineHeight: 1.15 },
	'& h3': { fontSize: '1.35rem', lineHeight: 1.3 },
	'& a:focus-visible, & button:focus-visible': {
		outline: `3px solid ${colors.primary}`,
		outlineOffset: '5px',
	},
	'& .hero': {
		display: 'grid',
		gridTemplateColumns: '1.15fr 1fr',
		gap: '4rem',
		alignItems: 'end',
		paddingBottom: '3.5rem',
	},
	'& .intro p:first-child': {
		fontFamily: typography.fontFamilyDisplay,
		fontSize: '1.7rem',
		lineHeight: 1.3,
		marginBottom: '1rem',
	},
	'& .intro p + p': { color: colors.textMuted, marginBottom: '1.5rem' },
	'& .anatomy': {
		background: 'light-dark(#edf0e8, var(--color-surface))',
		color: 'light-dark(#263d33, var(--color-text))',
		border: '1px solid light-dark(#cbd5c6, var(--color-border))',
	},
	'& .example-bar': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		justifyContent: 'space-between',
		gap: '0.5rem 2rem',
		padding: '1rem 1.5rem',
		borderBottom: '1px solid light-dark(#cbd5c6, var(--color-border))',
		fontSize: '0.8rem',
	},
	'& .example-bar span': {
		color: 'light-dark(#526657, var(--color-text-muted))',
	},
	'& .choices': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '0.5rem',
		padding: '1.25rem 1.5rem 0',
	},
	'& .choices button': {
		font: 'inherit',
		border: '1px solid light-dark(#a9b8a9, var(--color-border))',
		padding: '0.6rem 1rem',
		borderRadius: '2rem',
		background: 'transparent',
		color: 'inherit',
		cursor: 'pointer',
	},
	'& .choices button[aria-pressed="true"]': {
		color: 'light-dark(#f6f8ed, var(--color-on-primary))',
		background: 'light-dark(#263d33, var(--color-primary))',
		borderColor: 'light-dark(#263d33, var(--color-border))',
	},
	'& .workbench': { padding: '2rem 1.5rem 0' },
	'& .request': {
		display: 'grid',
		gridTemplateColumns: '1.1fr 1fr',
		gap: '3rem',
		paddingBottom: '2rem',
		alignItems: 'start',
	},
	'& .request h2': { fontSize: '2.1rem', maxWidth: '20ch' },
	'& dl': {
		display: 'grid',
		gridTemplateColumns: '6rem 1fr',
		gap: '0.7rem 1rem',
		margin: 0,
		fontSize: '0.85rem',
	},
	'& dt': { color: 'light-dark(#526657, var(--color-text-muted))' },
	'& dd': { margin: 0 },
	'& .pipeline': {
		listStyle: 'none',
		margin: 0,
		padding: 0,
		display: 'grid',
		gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
		gap: '1rem',
	},
	'& .pipeline li': {
		borderTop: '3px solid light-dark(#315947, var(--color-border))',
		padding: '1rem 0 1.7rem',
	},
	'& .pipeline li[data-kind="Judgment"]': {
		borderTopColor: 'light-dark(#a15e2e, var(--color-border))',
	},
	'& .step-top': {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: '1rem',
	},
	'& .sequence': {
		fontFamily: typography.fontFamilyMono,
		color: 'light-dark(#526657, var(--color-text-muted))',
		fontSize: '0.8rem',
	},
	'& .kind': {
		fontSize: '0.75rem',
		padding: '0.15rem 0.5rem',
		background: 'light-dark(#d8e3d4, var(--color-background))',
	},
	'& [data-kind="Judgment"] .kind': {
		background: 'light-dark(#f1dec4, var(--color-background))',
		color: 'light-dark(#74401d, var(--color-text-muted))',
	},
	'& .pipeline p': {
		fontSize: '0.85rem',
		marginTop: '0.65rem',
		color: 'light-dark(#526657, var(--color-text-muted))',
	},
	'& .result': {
		marginInline: '-1.5rem',
		background: 'light-dark(#263d33, var(--color-surface))',
		color: 'light-dark(#f6f8ed, var(--color-text))',
		padding: '1.3rem 1.5rem',
		display: 'grid',
		gridTemplateColumns: '4rem 1fr 1fr',
		gap: '1rem',
		alignItems: 'start',
	},
	'& .result span, & .result p': {
		fontSize: '0.8rem',
		color: 'light-dark(#d0ddca, var(--color-text))',
	},
	'& .boundary': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingBlock: '5rem',
	},
	'& .boundary p': { color: colors.textMuted, marginBottom: '1rem' },
	'& .directory': {
		borderTop: `1px solid ${colors.border}`,
		paddingBlock: '3rem',
	},
	'& .directory > h2': { marginBottom: '2.5rem' },
	'& .directory-group': {
		display: 'grid',
		gridTemplateColumns: '1fr 2fr',
		gap: '3rem',
		paddingBlock: '1.5rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& .directory-group h3': { maxWidth: '15ch' },
	'& .directory ul': { padding: 0, margin: 0, listStyle: 'none' },
	'& .directory li + li': { borderTop: `1px solid ${colors.border}` },
	'& .directory a': {
		display: 'flex',
		gap: '1rem',
		justifyContent: 'space-between',
		padding: '0.85rem 0',
		textDecoration: 'none',
	},
	'& .directory a:hover': { color: colors.primaryText },
	'& .start': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingTop: '3rem',
		borderTop: `1px solid ${colors.border}`,
		scrollMarginTop: '6rem',
	},
	'& .start p': { marginBlock: '1.3rem 1.5rem', color: colors.textMuted },
	'& .prompt': {
		paddingLeft: '1.5rem',
		borderLeft: `3px solid ${colors.primary}`,
	},
	'& blockquote': { margin: '1rem 0 1.5rem' },
	'& .reading': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '1rem 2rem',
		marginTop: '3rem',
		fontSize: '0.85rem',
	},
	'@media (max-width: 760px)': {
		padding: '2rem 1.25rem 3rem',
		'& h1': { fontSize: '2.9rem', maxWidth: '14ch' },
		'& h2': { fontSize: '2.15rem' },
		'& .hero, & .request, & .boundary, & .start': {
			gridTemplateColumns: '1fr',
			gap: '1.5rem',
		},
		'& .hero': { paddingBottom: '2rem' },
		'& .intro p:first-child': { fontSize: '1.4rem' },
		'& .choices': { padding: '1rem 1rem 0', gap: '0.4rem' },
		'& .choices button': { fontSize: '0.8rem', padding: '0.5rem 0.7rem' },
		'& .workbench': { padding: '1.5rem 1rem 0' },
		'& .request h2': { fontSize: '1.8rem' },
		'& .pipeline': { gridTemplateColumns: '1fr', gap: 0 },
		'& .pipeline li': { paddingBottom: '1.5rem' },
		'& .step-top': { marginBottom: '0.5rem' },
		'& .result': {
			marginInline: '-1rem',
			padding: '1.25rem 1rem',
			gridTemplateColumns: '1fr',
			gap: '0.5rem',
		},
		'& .boundary': { paddingBlock: '3rem' },
		'& .directory-group': { gridTemplateColumns: '1fr', gap: '0.5rem' },
		'& .directory-group h3': { maxWidth: 'none' },
		'& .directory a': { fontSize: '0.9rem' },
	},
}
